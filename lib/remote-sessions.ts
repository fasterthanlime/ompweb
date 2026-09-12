import { readRemotePageRange, isPagingConflict, type RemotePageCursor } from "./remote-paging";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { normalizeToolCalls } from "./normalize";
import type { AgentMessage } from "./types";
import { RpcCommandError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import { getRemoteTargets, type RemoteTarget } from "./remote-targets";
import { readRemoteControls, type RemoteControls } from "./remote-controls";
import { validateAgentImages } from "./image-attachments";
import { getSessionGoal, setSessionGoal } from "./session-preferences";
import {
  GOAL_TOOL,
  SET_GOAL_TOOL,
  goalPrompt,
  parseSetGoalArguments,
  validateSetGoalArguments,
  appendInteractionGuidance,
  type ActiveGoal,
} from "./web-mode-state";
import { THREAD_EXPRESSION_TOOLS, handleThreadExpressionTool, getRemoteReactionTargetId, previewMessage, MAX_REACTION_TARGETS, type ReactionTarget } from "./thread-expression";
import { VISUAL_TOOL, handleVisualTool } from "./visual-frame";
const SERVER_HOST_TOOLS = [...THREAD_EXPRESSION_TOOLS, VISUAL_TOOL, GOAL_TOOL, SET_GOAL_TOOL];
const SERVER_HOST_TOOL_NAMES = new Set(SERVER_HOST_TOOLS.map((tool) => tool.name));
const GOAL_TOOL_NAMES = new Set([GOAL_TOOL.name, SET_GOAL_TOOL.name]);

const REMOTE_SESSIONS_PATH = process.env.OMP_WEB_REMOTE_SESSIONS_PATH
  ?? `${homedir()}/.omp/agent/remote-sessions.json`;
const READY_TIMEOUT_MS = 120_000;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const MAX_ERROR_TAIL = 500;

export interface RemoteSessionDescriptor {
  id: string;
  targetId: string;
  sessionFile: string;
  remoteSessionId: string;
  name: string;
  cwd: string;
  modified?: string;
  archivedAt?: string;
}

export interface RemoteSessionInfo {
  id: string;
  targetId: string;
  remoteSessionId: string;
  name: string;
  cwd: string;
  connected: boolean;
  modified: string;
  running: boolean;
  runningSince?: number;
}

export interface RemoteSessionSnapshot {
  session: RemoteSessionInfo;
  messages: AgentMessage[];
  totalMessages: number;
  startIndex: number;
  hasMore: boolean;
  running: boolean;
  revision: number;
  streamId: string;
  error?: string;
}

export type RemoteReactionTarget = ReactionTarget;

export type RemoteStreamMessage =
  | { type: "snapshot"; messages: AgentMessage[]; totalMessages: number; startIndex: number; hasMore: boolean; running: boolean; session: RemoteSessionInfo; revision: number; streamId: string }
  | { type: "event"; event: RpcFrame; messageIndex?: number; revision: number; streamId: string }
  | { type: "error"; error: string };

type RemoteListener = (message: RemoteStreamMessage) => void;


type Runtime = {
  proc?: RpcProcess;
  connectPromise?: Promise<void>;
  pendingPrompt?: Promise<unknown>;
  listeners: Set<RemoteListener>;
  /** The bounded latest page, never the entire remote transcript. */
  messages: AgentMessage[];
  totalMessages: number;
  messageStartIndex: number;
  pageCursorSeed?: RemotePageCursor;
  /** Monotonic server-side stream sequence for this process epoch. */
  revision: number;
  /** Changes whenever a fresh remote process is spawned. */
  streamId: string;
  /** Absolute index currently being streamed, if any. */
  liveMessageIndex?: number;
  /** A refresh requested while another refresh is in flight. */
  refreshQueued?: boolean;
  /** True while abort_and_prompt is replacing the current turn. */
  interrupting: boolean;
  running: boolean;
  runningSince?: number;
  compacting: boolean;
  goal: ActiveGoal | null;
  error?: string;
  idleTimer?: NodeJS.Timeout;
  refreshPromise?: Promise<void>;
  goalContinuation?: NodeJS.Immediate;
  unsubscribeFrames?: () => void;
};


type RemoteState = {
  sessions: Map<string, RemoteSessionDescriptor>;
  runtimes: Map<string, Runtime>;
};



const STATE_KEY = Symbol.for("ompweb.remote-sessions.state");
const globalState = globalThis as typeof globalThis & { [STATE_KEY]?: RemoteState };
const state: RemoteState = globalState[STATE_KEY] ?? (globalState[STATE_KEY] = loadState());

export class RemoteSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "remote_session_error", status = 400) {
    super(message);
    this.name = "RemoteSessionError";
    this.code = code;
    this.status = status;
  }
}

function loadState(): RemoteState {
  const sessions = new Map<string, RemoteSessionDescriptor>();
  try {
    const parsed = JSON.parse(readFileSync(REMOTE_SESSIONS_PATH, "utf8")) as { version?: unknown; sessions?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return { sessions, runtimes: new Map() };
    for (const value of parsed.sessions) {
      if (!isDescriptor(value)) continue;
      sessions.set(value.id, value);
    }
  } catch {
    // A missing or malformed registry is treated as an empty registry. The
    // next successful mutation writes a fresh, valid snapshot atomically.
  }
  return { sessions, runtimes: new Map() };
}

function isDescriptor(value: unknown): value is RemoteSessionDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ["id", "targetId", "sessionFile", "remoteSessionId", "name", "cwd"]
    .every((key) => typeof candidate[key] === "string")
    && Boolean(candidate.id)
    && Boolean(candidate.targetId)
    && Boolean(candidate.cwd);
}

function persistState(): void {
  const sessions = [...state.sessions.values()];
  const directory = dirname(REMOTE_SESSIONS_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${REMOTE_SESSIONS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, REMOTE_SESSIONS_PATH);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function runtimeFor(id: string): Runtime {
  let runtime = state.runtimes.get(id);
  if (!runtime) {
    runtime = {
      listeners: new Set(),
      messages: [],
      totalMessages: 0,
      messageStartIndex: 0,
      running: false,
      compacting: false,
      goal: null,
      revision: 0,
      streamId: randomUUID(),
      interrupting: false,
    };
    state.runtimes.set(id, runtime);
  }
  runtime.revision ??= 0;
  runtime.streamId ??= randomUUID();
  return runtime;
}

function emitGoalUpdate(id: string): void {
  const runtime = runtimeFor(id);
  emit(id, { type: "event", event: { type: "web_goal_updated", goal: runtime.goal }, revision: ++runtime.revision, streamId: runtime.streamId });
}

function updateRemoteGoal(id: string, goal: ActiveGoal | null): void {
  const runtime = runtimeFor(id);
  if (runtime.goalContinuation) {
    clearImmediate(runtime.goalContinuation);
    runtime.goalContinuation = undefined;
  }
  runtime.goal = goal;
  setSessionGoal(id, goal);
  emitGoalUpdate(id);
  emitSnapshot(id);
}

function pauseRemoteGoal(id: string, summary: string): void {
  const runtime = runtimeFor(id);
  if (runtime.goal?.status !== "active") return;
  updateRemoteGoal(id, { ...runtime.goal, status: "paused", summary });
}

function scheduleRemoteGoalContinuation(id: string): void {
  const runtime = runtimeFor(id);
  if (runtime.goalContinuation || runtime.goal?.status !== "active") return;
  const goal = runtime.goal;
  runtime.goalContinuation = setImmediate(async () => {
    runtime.goalContinuation = undefined;
    if (runtime.pendingPrompt) { try { await runtime.pendingPrompt; } catch { return; } }
    if (runtime.goal !== goal || goal.status !== "active" || !runtime.proc?.isAlive || runtime.running) return;
    void sendRemotePrompt(id, goalPrompt(goal)).catch((error) => {
      if (runtime.goal === goal) updateRemoteGoal(id, { ...goal, status: "paused", summary: sanitizeError(error) || "Goal continuation failed." });
      emit(id, { type: "error", error: sanitizeError(error) || "Goal continuation failed." });
    });
  });
  runtime.goalContinuation.unref?.();
}

function descriptorOrThrow(id: string): RemoteSessionDescriptor {
  const descriptor = state.sessions.get(id);
  if (!descriptor) throw new RemoteSessionError("Remote session not found", "remote_session_not_found", 404);
  return descriptor;
}

function findTarget(targetId: string): RemoteTarget {
  let targets: RemoteTarget[];
  try {
    targets = getRemoteTargets();
  } catch {
    throw new RemoteSessionError("Remote target configuration is invalid", "remote_target_config_invalid", 503);
  }
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new RemoteSessionError("Remote target is not configured", "remote_target_not_configured", 404);
  return target;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // RpcProcess includes a bounded stderr tail. Never return a raw multiline
  // diagnostic to the browser: ssh tools occasionally echo environment or
  // command arguments. Keep only a short final line with obvious credentials
  // and control characters removed.
  const line = raw.replace(/[\u0000-\u001f\u007f]/g, " ").split(/\s*\n\s*/).filter(Boolean).pop() ?? "";
  const scrubbed = line
    .replace(/(password|passphrase|token|secret|api[_-]?key)\s*[=:]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/(ssh|https?):\/\/[^\s]+/gi, "$1://[redacted]");
  return scrubbed.length > MAX_ERROR_TAIL ? scrubbed.slice(-MAX_ERROR_TAIL) : scrubbed;
}

function connectionError(error: unknown): RemoteSessionError {
  if (error instanceof RemoteSessionError) return error;
  if (error instanceof RpcCommandError) {
    return new RemoteSessionError(`Remote OMP command failed: ${sanitizeError(error)}`, error.code ?? "remote_rpc_failed", 502);
  }
  const detail = sanitizeError(error);
  return new RemoteSessionError(detail ? `Remote connection failed: ${detail}` : "Remote connection failed", "remote_connection_failed", 502);
}

function publicSession(descriptor: RemoteSessionDescriptor, runtime: Runtime): RemoteSessionInfo {
  return {
    id: descriptor.id,
    targetId: descriptor.targetId,
    remoteSessionId: descriptor.remoteSessionId,
    name: descriptor.name,
    cwd: descriptor.cwd,
    connected: Boolean(runtime.proc?.isAlive),
    modified: descriptor.modified ?? descriptor.sessionFile.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)?.[0].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3') ?? "",
    running: runtime.running,
    runningSince: runtime.running ? runtime.runningSince : undefined,
  };
}
function emit(id: string, message: RemoteStreamMessage): void {
  const runtime = state.runtimes.get(id);
  if (!runtime) return;
  for (const listener of runtime.listeners) {
    try { listener(message); } catch {}
  }
}

function emitSnapshot(id: string): void {
  const descriptor = state.sessions.get(id);
  const runtime = state.runtimes.get(id);
  if (!descriptor || !runtime) return;
  emit(id, {
    type: "snapshot",
    messages: runtime.messages,
    totalMessages: runtime.totalMessages,
    startIndex: runtime.messageStartIndex,
    hasMore: runtime.messageStartIndex > 0,
    running: runtime.running,
    session: publicSession(descriptor, runtime),
    revision: runtime.revision,
    streamId: runtime.streamId,
  });
}

function scheduleIdleClose(id: string): void {
  const runtime = runtimeFor(id);
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.listeners.size > 0 || runtime.running || !runtime.proc?.isAlive) return;
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = undefined;
    if (runtime.listeners.size === 0 && !runtime.running) void closeRuntime(id);
  }, IDLE_CLOSE_MS);
  runtime.idleTimer.unref?.();
}

async function closeRuntime(id: string): Promise<void> {
  const runtime = state.runtimes.get(id);
  if (!runtime) return;
  runtime.unsubscribeFrames?.();
  runtime.unsubscribeFrames = undefined;
  const proc = runtime.proc;
  runtime.proc = undefined;
  runtime.running = false;
  runtime.connectPromise = undefined;
  if (proc) await proc.dispose().catch(() => {});
  emitSnapshot(id);
}

function parseMessages(value: unknown): AgentMessage[] {
  let raw: unknown = value;
  if (Array.isArray(value)) raw = value;
  else if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).messages)) {
    raw = (value as Record<string, unknown>).messages;
  } else {
    throw new Error("Remote get_messages_page returned an unsupported shape");
  }
  return (raw as unknown[]).map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof (message as Record<string, unknown>).role !== "string") {
      throw new Error("Remote get_messages_page returned an invalid message");
    }
    return normalizeToolCalls(message as AgentMessage);
  });
}

async function refreshMessages(id: string, proc: RpcProcess): Promise<void> {
  const runtime = runtimeFor(id);
  const revision = runtime.revision;
  const remoteState = await proc.sendCommand<{ isStreaming?: boolean; isCompacting?: boolean }>({ type: "get_state" });
  if (remoteState.isStreaming || remoteState.isCompacting || runtime.interrupting) return;
  let page;
  try { page = await readRemotePageRange(proc); }
  catch (error) { if (isPagingConflict(error)) return; throw error; }
  if (runtime.proc !== proc || runtime.revision !== revision) return;
  runtime.pageCursorSeed = page.seed;
  runtime.running = false;
  runtime.compacting = false;
  runtime.revision++;
  runtime.messages = parseMessages(page.messages);
  runtime.totalMessages = page.totalMessages;
  runtime.messageStartIndex = page.startIndex;
  const timestamp = runtime.messages.reduce((latest, message) => "timestamp" in message && typeof message.timestamp === "number" ? Math.max(latest, message.timestamp) : latest, 0);
  if (timestamp) { descriptorOrThrow(id).modified = new Date(timestamp).toISOString(); persistState(); }
  emitSnapshot(id);
}

async function getRemotePage(id: string, before?: number, limit = 100): Promise<RemoteSessionSnapshot> {
  descriptorOrThrow(id);
  await connect(id);
  const runtime = runtimeFor(id);
  const totalMessages = runtime.totalMessages;
  const end = before === undefined ? totalMessages : Math.min(before, totalMessages);
  const startIndex = Math.max(0, end - limit);
  if (before === 0) {
    return { revision: runtime.revision, streamId: runtime.streamId, session: publicSession(descriptorOrThrow(id), runtime), messages: [], totalMessages, startIndex: 0, hasMore: false, running: runtime.running, ...(runtime.error ? { error: runtime.error } : {}) };
  }
  if (before === undefined || startIndex >= runtime.messageStartIndex) {
    const messages = before === undefined ? runtime.messages : runtime.messages.slice(startIndex - runtime.messageStartIndex, end - runtime.messageStartIndex);
    return { revision: runtime.revision, streamId: runtime.streamId, session: publicSession(descriptorOrThrow(id), runtime), messages, totalMessages, startIndex: before === undefined ? runtime.messageStartIndex : startIndex, hasMore: startIndex > 0, running: runtime.running, ...(runtime.error ? { error: runtime.error } : {}) };
  }
  const proc = runtime.proc;
  if (!proc) throw new RemoteSessionError("Remote history unavailable", "remote_history_unavailable", 503);
  const epoch = runtime.streamId;
  const revision = runtime.revision;
  try {
    const page = await readRemotePageRange(proc, end, limit);
    if (runtime.proc !== proc || runtime.streamId !== epoch) throw new RemoteSessionError("Thread changed during history request", "history_changed", 409);
    return { revision, streamId: epoch, session: publicSession(descriptorOrThrow(id), runtime), messages: parseMessages(page.messages), totalMessages: page.totalMessages, startIndex: page.startIndex, hasMore: page.startIndex > 0, running: runtime.running };
  } catch (error) {
    if (isPagingConflict(error)) throw new RemoteSessionError("Older history is available when the current response finishes", "history_busy", 409);
    throw error;
  }
}

function goalResult(proc: RpcProcess, id: string, text: string, isError = false): void {
  proc.sendFrame({
    type: "host_tool_result",
    id,
    ...(isError ? { isError: true } : {}),
    result: { content: [{ type: "text", text }] },
  });
}

function handleRemoteGoalTool(id: string, event: RpcFrame, toolName: string): void {
  const requestId = typeof event.id === "string" ? event.id : "";
  const runtime = runtimeFor(id);
  const proc = runtime.proc;
  if (!requestId || !proc?.isAlive) return;
  try {
    if (toolName === SET_GOAL_TOOL.name) {
      const args = parseSetGoalArguments(event.arguments);
      validateSetGoalArguments(runtime.goal, args, { activeTurn: runtime.running });
      if (args.action === "clear") {
        updateRemoteGoal(id, null);
        goalResult(proc, requestId, appendInteractionGuidance(id, "Goal cleared."));
        return;
      }
      const goal: ActiveGoal = { id: randomUUID(), objective: args.objective!, startedAt: Date.now(), status: "active" };
      updateRemoteGoal(id, goal);
      goalResult(proc, requestId, appendInteractionGuidance(id, goalPrompt(goal)));
      return;
    }
    const args = event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments)
      ? event.arguments as Record<string, unknown>
      : {};
    const valid = runtime.goal?.status === "active"
      && args.goalId === runtime.goal.id
      && (args.status === "completed" || args.status === "blocked")
      && typeof args.summary === "string" && args.summary.trim().length > 0;
    if (!valid) throw new Error("No matching active goal, or invalid status/summary.");
    goalResult(proc, requestId, appendInteractionGuidance(id, `Goal ${args.status}.`));
  } catch (error) {
    goalResult(proc, requestId, error instanceof Error ? error.message : String(error), true);
  }
}

function queueRefreshMessages(id: string, proc: RpcProcess): void {
  const runtime = runtimeFor(id);
  if (runtime.refreshPromise) { runtime.refreshQueued = true; return; }
  runtime.refreshPromise = refreshMessages(id, proc)
    .catch((error) => {
      const message = sanitizeError(error) || "Unable to refresh remote messages";
      runtime.error = message;
      emit(id, { type: "error", error: message });
    })
    .finally(() => {
      runtime.refreshPromise = undefined;
      if (runtime.refreshQueued && runtime.proc === proc) { runtime.refreshQueued = false; queueRefreshMessages(id, proc); }
    });
}

function remoteReactionTargets(id: string): ReactionTarget[] {
  const messages = runtimeFor(id).messages;
  const start = Math.max(0, messages.length - MAX_REACTION_TARGETS);
  return messages.slice(start).map((message, offset) => ({
    id: getRemoteReactionTargetId(message, runtimeFor(id).messageStartIndex + start + offset),
    role: message.role,
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    preview: previewMessage(message),
  }));
}

async function handleServerHostTool(id: string, event: RpcFrame, toolName: string): Promise<void> {
  const requestId = typeof event.id === "string" ? event.id : "";
  if (!requestId) return;
  const proc = runtimeFor(id).proc;
  if (!proc?.isAlive) return;
  if (GOAL_TOOL_NAMES.has(toolName)) {
    handleRemoteGoalTool(id, event, toolName);
    return;
  }
  try {
    const result = toolName === VISUAL_TOOL.name
      ? await handleVisualTool(id, event.arguments, {
        hostToolCallId: requestId,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      })
      : await handleThreadExpressionTool(id, toolName, event.arguments, () => remoteReactionTargets(id));
    proc.sendFrame({ type: "host_tool_result", id: requestId, result: { content: [{ type: "text", text: appendInteractionGuidance(id, result.content[0].text) }] } });
  } catch (error) {
    proc.sendFrame({
      type: "host_tool_result",
      id: requestId,
      isError: true,
      result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
    });
  }
}
function handleFrame(id: string, frame: RpcFrame): void {
  const runtime = runtimeFor(id);
  runtime.error = undefined;
  runtime.revision++;
  let messageIndex: number | undefined;
  if (["message_start", "message_update", "message_end"].includes(frame.type) && frame.message && typeof frame.message === "object") {
    const message = normalizeToolCalls(frame.message as AgentMessage);
    messageIndex = runtime.liveMessageIndex;
    if (frame.type === "message_start" || messageIndex === undefined) messageIndex = runtime.totalMessages;
    runtime.liveMessageIndex = messageIndex;
    const offset = messageIndex - runtime.messageStartIndex;
    if (offset >= 0 && offset <= runtime.messages.length) {
      if (offset === runtime.messages.length) runtime.messages = [...runtime.messages, message];
      else runtime.messages = runtime.messages.map((existing, index) => index === offset ? message : existing);
      runtime.totalMessages = Math.max(runtime.totalMessages, messageIndex + 1);
      if (runtime.messages.length > 100) { const drop = runtime.messages.length - 100; runtime.messages = runtime.messages.slice(drop); runtime.messageStartIndex += drop; }
    }
    if (frame.type === "message_end") runtime.liveMessageIndex = undefined;
  }
  if (frame.type === "agent_start") { runtime.running = true; runtime.runningSince = Date.now(); runtime.interrupting = false; }
  if (frame.type === "auto_compaction_start") runtime.compacting = true;
  if (frame.type === "auto_compaction_end") runtime.compacting = false;
  if (frame.type === "agent_end" && frame.isTerminal !== false) {
    runtime.running = false;
    if (runtime.goal?.status === "active") {
      const messages = Array.isArray(frame.messages) ? frame.messages as Array<{ role?: string; stopReason?: string }> : [];
      const lastAssistant = messages.findLast((message) => message.role === "assistant");
      if (lastAssistant?.stopReason !== "stop") pauseRemoteGoal(id, "Turn interrupted or failed; reconnect or resume the goal from the user interface.");
      else {
        scheduleRemoteGoalContinuation(id);
        frame.isTerminal = false;
      }
    }
  }
  if (frame.type === "host_tool_call" && typeof frame.toolName === "string" && SERVER_HOST_TOOL_NAMES.has(frame.toolName)) {
    void handleServerHostTool(id, frame, frame.toolName);
    return;
  }
  if (["agent_start", "agent_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_compaction_start", "auto_compaction_end", "web_goal_updated", "session_info_update"].includes(frame.type)) emit(id, { type: "event", event: frame, messageIndex, revision: runtime.revision, streamId: runtime.streamId });
  const proc = runtime.proc;
  if (proc && (frame.type === "agent_end" || frame.type === "auto_compaction_end")) queueRefreshMessages(id, proc);
  scheduleIdleClose(id);
}
async function connect(id: string): Promise<void> {
  const descriptor = descriptorOrThrow(id);
  if (descriptor.archivedAt) throw new RemoteSessionError("Restore this archived thread before reconnecting", "session_archived", 409);
  const runtime = runtimeFor(id);
  if (runtime.proc?.isAlive) return;
  if (runtime.connectPromise) return runtime.connectPromise;
  const target = findTarget(descriptor.targetId);
  runtime.error = undefined;
  runtime.streamId = randomUUID();
  runtime.revision = 0;
  runtime.liveMessageIndex = undefined;
  const promise = (async () => {
    const proc = new RpcProcess({
      cwd: target.cwd,
      ssh: { destination: target.destination, ompBin: target.ompBin },
      extraArgs: descriptor.sessionFile ? ["--resume", descriptor.sessionFile] : [],
      onExit: ({ stderrTail }) => {
        if (runtime.proc !== proc) return;
        runtime.unsubscribeFrames?.();
        runtime.unsubscribeFrames = undefined;
        runtime.proc = undefined;
        runtime.running = false;
        runtime.compacting = false;
        if (runtime.goalContinuation) {
          clearImmediate(runtime.goalContinuation);
          runtime.goalContinuation = undefined;
        }
        pauseRemoteGoal(id, "Remote connection closed; reconnect or resume the goal from the user interface.");
        runtime.error = sanitizeError(stderrTail) || "Remote connection closed";
        emit(id, { type: "error", error: runtime.error });
        emitSnapshot(id);
      },
    });
    runtime.proc = proc;
    runtime.unsubscribeFrames = proc.onFrame(frame => handleFrame(id, frame));
    try {
      const ready = await proc.waitReady(READY_TIMEOUT_MS);
      await proc.negotiateProtocol(ready);
      const stateValue = await proc.sendCommand<Record<string, unknown>>({ type: "get_state" });
      const remoteSessionId = typeof stateValue.sessionId === "string" ? stateValue.sessionId : "";
      const sessionFile = typeof stateValue.sessionFile === "string" ? stateValue.sessionFile : descriptor.sessionFile;
      if (!remoteSessionId) throw new Error("Remote OMP did not return a session id");
      descriptor.remoteSessionId = remoteSessionId;
      descriptor.sessionFile = sessionFile;
      if (typeof stateValue.sessionName === "string" && stateValue.sessionName.trim()) descriptor.name = stateValue.sessionName;
      state.sessions.set(id, descriptor);
      persistState();
      runtime.running = stateValue.isStreaming === true;
      runtime.compacting = stateValue.isCompacting === true;
      runtime.goal = getSessionGoal(id);
      if (runtime.goal?.status === "active") updateRemoteGoal(id, { ...runtime.goal, status: "paused", summary: "Session reconnected; use /goal resume to continue." });
      await proc.sendCommand({ type: "set_host_tools", tools: SERVER_HOST_TOOLS });
      await refreshMessages(id, proc);
      emitSnapshot(id);
    } catch (error) {
      if (runtime.proc === proc) {
        runtime.proc = undefined;
        runtime.running = false;
        runtime.compacting = false;
      }
      await proc.dispose().catch(() => {});
      throw connectionError(error);
    }
  })();
  runtime.connectPromise = promise;
  try {
    await promise;
  } catch (error) {
    runtime.error = error instanceof Error ? error.message : String(error);
    emit(id, { type: "error", error: runtime.error });
    throw error;
  } finally {
    if (runtime.connectPromise === promise) runtime.connectPromise = undefined;
  }
}
export function listRemoteSessions(): {
  targets: Array<{ id: string; name: string; cwd: string; hostname: string; platform?: string }>;
  sessions: RemoteSessionInfo[];
} {
  let targets: RemoteTarget[];
  try {
    targets = getRemoteTargets();
  } catch {
    throw new RemoteSessionError("Remote target configuration is invalid", "remote_target_config_invalid", 503);
  }
  const configured = targets.map((target) => ({
    id: target.id,
    name: target.name,
    cwd: target.cwd,
    hostname: target.destination.split("@").pop() ?? target.destination,
    platform: target.platform,
  }));
  const sessions = [...state.sessions.values()].filter(descriptor => !descriptor.archivedAt).map((descriptor) => publicSession(descriptor, runtimeFor(descriptor.id)));
  return { targets: configured, sessions };
}

export async function createRemoteSession(targetId: string): Promise<RemoteSessionSnapshot> {
  const target = findTarget(targetId);
  const id = randomUUID();
  const descriptor: RemoteSessionDescriptor = {
    id,
    targetId: target.id,
    sessionFile: "",
    remoteSessionId: "",
    name: target.name,
    cwd: target.cwd,
  };
  state.sessions.set(id, descriptor);
  persistState();
  try {
    await connect(id);
    return getRemoteSession(id);
  } catch (error) {
    return getRemoteSession(id, error instanceof Error ? error.message : String(error));
  }
}

export function getRemoteSession(id: string, error?: string): RemoteSessionSnapshot {
  const descriptor = descriptorOrThrow(id);
  const runtime = runtimeFor(id);
  return {
    revision: runtime.revision,
    streamId: runtime.streamId,
    session: publicSession(descriptor, runtime),
    messages: runtime.messages,
    totalMessages: runtime.totalMessages,
    startIndex: runtime.messageStartIndex,
    hasMore: runtime.messageStartIndex > 0,
    running: runtime.running,
    ...(error || runtime.error ? { error: error ?? runtime.error } : {}),
  };
}
export function isRemoteSession(id: string): boolean { return state.sessions.has(id); }

export async function getRemoteSessionPage(id: string, before?: number, limit = 100): Promise<RemoteSessionSnapshot> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before < 0))) throw new RemoteSessionError("Invalid history page", "invalid_page", 400);
  await connect(id);
  if (before === undefined) {
    const runtime = runtimeFor(id);
    if (runtime.proc) { queueRefreshMessages(id, runtime.proc); await runtime.refreshPromise; }
  }
  return getRemotePage(id, before, limit);
}

export async function getRemoteReactionTargets(id: string): Promise<ReactionTarget[]> {
  await connect(id);
  return remoteReactionTargets(id);
}

export async function connectRemoteSession(id: string): Promise<RemoteSessionSnapshot> {
  await connect(id);
  return getRemoteSession(id);
}
export async function readRemoteSubagents(id: string, subagentId?: string, fromByte = 0): Promise<unknown> {
  await connect(id);
  const proc = runtimeFor(id).proc!;
  if (subagentId === undefined) return proc.sendCommand({ type: "get_subagents" });
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(subagentId) || !Number.isSafeInteger(fromByte) || fromByte < 0) throw new RemoteSessionError("Invalid subagent page", "invalid_subagent_page", 400);
  return proc.sendCommand({ type: "get_subagent_messages", subagentId, fromByte });
}
export async function forkRemoteSession(id: string, entryId: string): Promise<RemoteSessionSnapshot> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(entryId)) throw new RemoteSessionError("Invalid branch entry", "invalid_entry", 400);
  await connect(id);
  const runtime = runtimeFor(id);
  if (runtime.running || runtime.compacting) throw new RemoteSessionError("Session is busy", "session_busy", 409);
  const original = descriptorOrThrow(id);
  const proc = runtime.proc!;
  const result = await proc.sendCommand<{ cancelled?: boolean }>({ type: "branch", entryId });
  if (result.cancelled) throw new RemoteSessionError("Fork cancelled", "fork_cancelled", 409);
  const identity = await proc.sendCommand<Record<string, unknown>>({ type: "get_state" });
  if (typeof identity.sessionId !== "string" || typeof identity.sessionFile !== "string") throw new RemoteSessionError("Fork identity unavailable", "fork_identity", 502);
  const nextId = randomUUID();
  state.sessions.set(nextId, { ...original, id: nextId, remoteSessionId: identity.sessionId, sessionFile: identity.sessionFile, name: typeof identity.sessionName === "string" ? identity.sessionName : original.name, modified: new Date().toISOString() });
  persistState();
  await closeRuntime(id);
  await connect(nextId);
  return getRemoteSession(nextId);
}

export async function remoteBranchEntries(id: string): Promise<unknown> {
  await connect(id);
  return runtimeFor(id).proc!.sendCommand({ type: "get_branch_messages" });
}

export async function remoteControls(id: string, command?: {
  type: "get_controls" | "set_model" | "set_thinking_level" | "set_session_name" | "compact" | "abort_compaction" | "set_goal";
  provider?: string;
  modelId?: string;
  level?: string;
  name?: string;
  customInstructions?: string;
  action?: "start" | "clear" | "pause" | "resume";
  objective?: string;
  goalId?: string;
}): Promise<RemoteControls> {
  await connect(id);
  const runtime = runtimeFor(id);
  const proc = runtime.proc;
  if (!proc?.isAlive) throw new RemoteSessionError("Remote session is disconnected", "remote_disconnected", 503);
  if (command && command.type !== "get_controls") {
    if (command.type === "set_goal") {
      const action = command.action ?? "start";
      if (action === "clear") {
        // This is a direct user command; unlike an agent tool, it may clear a paused goal.
        updateRemoteGoal(id, null);
      } else if (action === "pause") {
        pauseRemoteGoal(id, "Paused by user.");
      } else if (action === "resume") {
        if (!runtime.goal || runtime.goal.status !== "paused" || runtime.running) throw new RemoteSessionError("No idle paused goal to resume", "goal_not_resumable", 409);
        const goal: ActiveGoal = { ...runtime.goal, status: "active", summary: undefined };
        updateRemoteGoal(id, goal);
        await sendRemotePrompt(id, goalPrompt(goal));
      } else {
        if (typeof command.objective !== "string" || !command.objective.trim()) throw new RemoteSessionError("A non-empty goal objective is required", "goal_objective_required", 400);
        if (runtime.goal?.status === "active" || runtime.goal?.status === "paused") throw new RemoteSessionError(`A ${runtime.goal.status} goal already exists`, "goal_exists", 409);
        if (runtime.running) throw new RemoteSessionError("Goals can only be created from an idle remote control request", "goal_busy", 409);
        const goal: ActiveGoal = { id: randomUUID(), objective: command.objective.trim(), startedAt: Date.now(), status: "active" };
        updateRemoteGoal(id, goal);
        try {
          await sendRemotePrompt(id, goalPrompt(goal));
        } catch (error) {
          if (runtime.goal === goal) pauseRemoteGoal(id, sanitizeError(error) || "Goal start failed.");
          throw error;
        }
      }
    } else if (command.type === "compact") {
      if (runtime.compacting || runtime.running) throw new RemoteSessionError("Session is busy", "session_busy", 409);
      runtime.compacting = true;
      emitSnapshot(id);
      try {
        await proc.sendCommand({ type: "compact", ...(command.customInstructions ? { customInstructions: command.customInstructions } : {}) });
        await refreshMessages(id, proc);
      } catch (error) {
        throw connectionError(error);
      } finally {
        runtime.compacting = false;
        emitSnapshot(id);
      }
    } else if (command.type === "abort_compaction") {
      pauseRemoteGoal(id, "Paused by user.");
      try {
        await proc.sendCommand({ type: "abort" });
      } catch (error) {
        throw connectionError(error);
      }
      runtime.compacting = false;
      runtime.running = false;
      pauseRemoteGoal(id, "Paused by user.");
      emitSnapshot(id);
    } else {
      try {
        await proc.sendCommand(command as { type: string; [key: string]: unknown });
      } catch (error) {
        throw connectionError(error);
      }
      if (command.type === "set_session_name" && command.name) {
        descriptorOrThrow(id).name = command.name;
        persistState();
        emitSnapshot(id);
      }
    }
  }
  const controls = await readRemoteControls(proc, runtime.goal);
  return { ...controls, isCompacting: runtime.compacting || controls.isCompacting, goal: runtime.goal };
}

function normalizeRemotePromptImages(value: unknown): Array<{ data: string; mimeType: string }> | undefined {
  if (value === undefined) return undefined;

  // validateAgentImages uses the rpc-manager image shape, which includes a
  // type discriminator. The remote API intentionally accepts ChatInput's
  // smaller {data, mimeType} shape and adds the discriminator only while
  // validating. Keep the original discriminator when supplied so invalid
  // command shapes are rejected rather than normalized into valid ones.
  const validationValue = Array.isArray(value)
    ? value.map((image) => {
      if (!image || typeof image !== "object" || Array.isArray(image)) return image;
      const record = image as Record<string, unknown>;
      return "type" in record ? image : { type: "image", ...record };
    })
    : value;
  const imageError = validateAgentImages(validationValue);
  if (imageError) throw new RemoteSessionError(imageError, "invalid_images", 400);

  // Explicitly project the wire shape. In particular, previewUrl is local
  // object-URL state and must never cross the remote RPC boundary.
  return (validationValue as Array<Record<string, unknown>>).map((image) => ({
    data: image.data as string,
    mimeType: image.mimeType as string,
  }));
}

export async function sendRemotePrompt(id: string, message: string, rawImages?: unknown): Promise<unknown> {
  const images = normalizeRemotePromptImages(rawImages);
  const goalCommand = message.trim().match(/^\/goal(?:\s+([\s\S]*))?$/);
  if (goalCommand && !images?.length) {
    const args = goalCommand[1]?.trim() ?? "";
    if (!args) return remoteControls(id);
    if (args === "clear" || args === "pause" || args === "resume") return remoteControls(id, { type: "set_goal", action: args });
    return remoteControls(id, { type: "set_goal", action: "start", objective: args });
  }
  if (!message.trim() && !images?.length) throw new RemoteSessionError("Prompt message is required", "prompt_required", 400);
  const descriptor = descriptorOrThrow(id);
  const runtime = runtimeFor(id);
  if (runtime.pendingPrompt) throw new RemoteSessionError("A remote prompt is already being sent", "prompt_in_flight", 409);
  if (runtime.running) throw new RemoteSessionError("The remote session is already running", "session_running", 409);
  await connect(id);
  if (runtime.pendingPrompt || runtime.running) throw new RemoteSessionError("The remote session is already running", "session_running", 409);
  const proc = runtime.proc;
  if (!proc?.isAlive) throw new RemoteSessionError("Remote session is disconnected", "remote_disconnected", 503);
  runtime.error = undefined;
  const pending = proc.sendCommand({
    type: "prompt",
    message,
    ...(images?.length ? { images } : {}),
  });
  runtime.pendingPrompt = pending;
  runtime.running = true;
  emitSnapshot(id);
  try {
    return await pending;
  } catch (error) {
    runtime.running = false;
    pauseRemoteGoal(id, "Prompt failed; use /goal resume after resolving the error.");
    runtime.error = sanitizeError(error);
    throw connectionError(error);
  } finally {
    if (runtime.pendingPrompt === pending) runtime.pendingPrompt = undefined;
    scheduleIdleClose(descriptor.id);
  }
}

export async function submitRemotePrompt(id: string, message: string, rawImages?: unknown): Promise<unknown> {
  const images = normalizeRemotePromptImages(rawImages);
  if (!message.trim() && !images?.length) throw new RemoteSessionError("Prompt message is required", "prompt_required", 400);
  if (/^\/goal(?:\s|$)/.test(message.trim()) && !images?.length) return sendRemotePrompt(id, message);
  await connect(id);
  const runtime = runtimeFor(id);
  const proc = runtime.proc;
  if (!proc?.isAlive) throw new RemoteSessionError("Remote session is disconnected", "remote_disconnected", 503);
  pauseRemoteGoal(id, "Paused by user reply.");
  runtime.interrupting = true;
  runtime.running = true;
  emitSnapshot(id);
  try {
    const result = await proc.sendCommand({ type: "abort_and_prompt", message, ...(images?.length ? { images } : {}) });
    runtime.interrupting = false;
    queueRefreshMessages(id, proc);
    return result;
  } catch (error) {
    runtime.interrupting = false;
    runtime.error = sanitizeError(error);
    throw connectionError(error);
  }
}

export async function abortRemoteSession(id: string): Promise<unknown> {
  await connect(id);
  const runtime = runtimeFor(id);
  pauseRemoteGoal(id, "Paused by user.");
  const proc = runtime.proc;
  if (!proc?.isAlive) throw new RemoteSessionError("Remote session is disconnected", "remote_disconnected", 503);
  try {
    const result = await proc.sendCommand({ type: "abort" });
    runtime.running = false;
    runtime.interrupting = false;
    runtime.revision++;
    queueRefreshMessages(id, proc);
    emitSnapshot(id);
    return result;
  } catch (error) {
    throw connectionError(error);
  }
}

export function subscribeRemoteSession(id: string, listener: RemoteListener): () => void {
  descriptorOrThrow(id);
  const runtime = runtimeFor(id);
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }
  runtime.listeners.add(listener);
  emitSnapshot(id);
  if (runtime.proc) queueRefreshMessages(id, runtime.proc);
  return () => {
    runtime.listeners.delete(listener);
    scheduleIdleClose(id);
  };
}

export async function closeRemoteSessionRuntime(id: string): Promise<void> {
  descriptorOrThrow(id);
  await closeRuntime(id);
}


export function listArchivedRemoteSessions(): RemoteSessionDescriptor[] {
  return [...state.sessions.values()].filter(session => Boolean(session.archivedAt));
}
export async function archiveRemoteSession(id: string): Promise<void> {
  const descriptor = descriptorOrThrow(id);
  const runtime = runtimeFor(id);
  if (runtime.running || runtime.compacting || runtime.pendingPrompt || runtime.connectPromise) throw new RemoteSessionError("Stop the thread before archiving it", "session_busy", 409);
  pauseRemoteGoal(id, "Archived by user.");
  descriptor.archivedAt = new Date().toISOString();
  persistState();
  await closeRuntime(id);
}
export function restoreRemoteSession(id: string): RemoteSessionDescriptor {
  const descriptor = descriptorOrThrow(id);
  if (!descriptor.archivedAt) throw new RemoteSessionError("Remote archive not found", "archive_not_found", 404);
  delete descriptor.archivedAt;
  persistState();
  return descriptor;
}
