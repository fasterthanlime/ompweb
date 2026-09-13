import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { AgentMessage, SessionEntry } from "./types";
import { getSessionEntries } from "./session-reader";
import { resolveInteractionAlias } from "./interaction-reminder";
import { extractInteractionAlias, stripInteractionReminder } from "./interaction-reminder-text";

export type ReactionActor = "user" | "agent";
export interface ThreadReaction { emoji: string; actor: ReactionActor }
export interface ThreadCelebration { id: string; effect: "confetti" | "sparkles"; messageId: string }
export interface ThreadExpressionState {
  expression: string;
  caption: string;
  expressionUpdatedAt?: number;
  reactions: Record<string, ThreadReaction[]>;
  celebration?: ThreadCelebration;
}
export interface ReactionTarget { id: string; role: string; timestamp?: number; preview: string; reminderAlias?: string }

export const MAX_EXPRESSION_CODEPOINTS = 32;
export const MAX_CAPTION_CODEPOINTS = 120;
export const MAX_REACTIONS_PER_MESSAGE_PER_ACTOR = 8;
export const MAX_REACTION_TARGETS = 200;
export const MAX_STORED_THREADS = 256;

const STATE_PATH = process.env.OMP_WEB_THREAD_EXPRESSIONS_PATH
  ?? `${homedir()}/.omp/agent/thread-expressions.json`;
const EMPTY_STATE: ThreadExpressionState = { expression: "", caption: "", reactions: {} };
const stateKey = Symbol.for("ompweb.thread-expression.state");
type StateStore = { threads: Map<string, ThreadExpressionState>; listeners: Map<string, Set<(state: ThreadExpressionState) => void>> };
const globalState = globalThis as typeof globalThis & { [stateKey]?: StateStore };
const store = globalState[stateKey] ?? (globalState[stateKey] = loadStore());

function cloneState(value: ThreadExpressionState): ThreadExpressionState {
  return {
    expression: value.expression,
    caption: value.caption,
    ...(typeof value.expressionUpdatedAt === "number" && Number.isFinite(value.expressionUpdatedAt)
      ? { expressionUpdatedAt: value.expressionUpdatedAt }
      : {}),
    reactions: Object.fromEntries(Object.entries(value.reactions).map(([id, reactions]) => [id, reactions.map((reaction) => ({ ...reaction }))])),
    ...(value.celebration ? { celebration: { ...value.celebration } } : {}),
  };
}

function limitCodePoints(value: string, max: number): string { return [...value].slice(0, max).join(""); }

function isValidEmoji(value: string): boolean {
  if (!value || [...value].length > 16) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  if (segments.length !== 1) return false;
  // Require an emoji-capable base while permitting variation selectors,
  // modifiers, regional flags, keycaps and ZWJ sequences.
  return /\p{Emoji}/u.test(value)
    && /^(?:[\p{Emoji}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3])+$/u.test(value)
    && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3)/u.test(value);
}

function parseReaction(value: unknown): ThreadReaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.actor !== "user" && record.actor !== "agent") || typeof record.emoji !== "string" || !isValidEmoji(record.emoji)) return null;
  return { actor: record.actor, emoji: record.emoji };
}

function parseState(value: unknown): ThreadExpressionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expression = typeof record.expression === "string" ? limitCodePoints(record.expression, MAX_EXPRESSION_CODEPOINTS) : "";
  const caption = typeof record.caption === "string" ? limitCodePoints(record.caption, MAX_CAPTION_CODEPOINTS) : "";
  const expressionUpdatedAt = typeof record.expressionUpdatedAt === "number" && Number.isFinite(record.expressionUpdatedAt)
    ? record.expressionUpdatedAt
    : undefined;
  const reactions: Record<string, ThreadReaction[]> = {};
  if (record.reactions && typeof record.reactions === "object" && !Array.isArray(record.reactions)) {
    for (const [messageId, raw] of Object.entries(record.reactions as Record<string, unknown>).slice(-MAX_REACTION_TARGETS)) {
      if (!messageId || !Array.isArray(raw)) continue;
      const bounded: ThreadReaction[] = [];
      for (const candidate of raw) {
        const reaction = parseReaction(candidate);
        if (!reaction || bounded.filter((entry) => entry.actor === reaction.actor).length >= MAX_REACTIONS_PER_MESSAGE_PER_ACTOR) continue;
        if (bounded.some((entry) => entry.actor === reaction.actor && entry.emoji === reaction.emoji)) continue;
        bounded.push(reaction);
      }
      if (bounded.length) reactions[messageId] = bounded;
    }
  }
  let celebration: ThreadCelebration | undefined;
  if (record.celebration && typeof record.celebration === "object" && !Array.isArray(record.celebration)) {
    const candidate = record.celebration as Record<string, unknown>;
    if (typeof candidate.id === "string" && candidate.id && typeof candidate.messageId === "string" && candidate.messageId
      && (candidate.effect === "confetti" || candidate.effect === "sparkles")) {
      celebration = { id: candidate.id, messageId: candidate.messageId, effect: candidate.effect };
    }
  }
  return {
    expression,
    caption,
    ...(expressionUpdatedAt === undefined ? {} : { expressionUpdatedAt }),
    reactions,
    ...(celebration ? { celebration } : {}),
  };
}

function loadStore(): StateStore {
  const threads = new Map<string, ThreadExpressionState>();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>;
    if (parsed.version === 1 && parsed.threads && typeof parsed.threads === "object" && !Array.isArray(parsed.threads)) {
      for (const [id, value] of Object.entries(parsed.threads as Record<string, unknown>).slice(-MAX_STORED_THREADS)) {
        if (id && id.length <= 256) {
          const state = parseState(value);
          if (state) threads.set(id, state);
        }
      }
    }
  } catch {
    // Missing or malformed state starts empty and is repaired on next mutation.
  }
  return { threads, listeners: new Map() };
}

function persistStore(): void {
  const directory = dirname(STATE_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const threads = Object.fromEntries([...store.threads.entries()].slice(-MAX_STORED_THREADS).map(([id, value]) => [id, cloneState(value)]));
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, threads })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, STATE_PATH);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function ensureThreadId(id: string): void {
  if (typeof id !== "string" || !id || id.length > 256) throw new Error("Invalid thread id");
}

function stateFor(id: string): ThreadExpressionState { return store.threads.get(id) ?? EMPTY_STATE; }

function commit(id: string, next: ThreadExpressionState): ThreadExpressionState {
  const ids = Object.keys(next.reactions);
  if (ids.length > MAX_REACTION_TARGETS) next = { ...next, reactions: Object.fromEntries(Object.entries(next.reactions).slice(-MAX_REACTION_TARGETS)) };
  store.threads.delete(id);
  store.threads.set(id, cloneState(next));
  while (store.threads.size > MAX_STORED_THREADS) {
    const oldest = store.threads.keys().next().value;
    if (oldest === undefined) break;
    store.threads.delete(oldest);
  }
  persistStore();
  const snapshot = cloneState(next);
  for (const listener of store.listeners.get(id) ?? []) {
    try { listener(snapshot); } catch {}
  }
  return snapshot;
}

export function getThreadExpression(id: string): ThreadExpressionState {
  ensureThreadId(id);
  return cloneState(stateFor(id));
}

export function subscribeThreadExpression(id: string, listener: (state: ThreadExpressionState) => void): () => void {
  ensureThreadId(id);
  let listeners = store.listeners.get(id);
  if (!listeners) store.listeners.set(id, listeners = new Set());
  listeners.add(listener);
  listener(getThreadExpression(id));
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) store.listeners.delete(id);
  };
}

export function getRemoteReactionTargetId(message: Pick<AgentMessage, "role"> & { timestamp?: number }, index: number): string {
  const role = typeof message.role === "string" && message.role ? message.role : "message";
  const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? String(message.timestamp) : "none";
  return `remote:${encodeURIComponent(role)}:${encodeURIComponent(timestamp)}:${Math.max(0, Math.floor(index))}`;
}

/** Stable target identity for server-side consumers; the browser imports the
 * equivalent implementation from thread-expression-target.ts. */
export function getReactionTargetId(role: string, timestamp: number | undefined, index: number, entryId?: string): string {
  if (entryId) return entryId;
  const normalizedRole = role || "message";
  const normalizedTimestamp = typeof timestamp === "number" && Number.isFinite(timestamp) ? String(timestamp) : "none";
  return `remote:${encodeURIComponent(normalizedRole)}:${encodeURIComponent(normalizedTimestamp)}:${Math.max(0, Math.floor(index))}`;
}

export function previewMessage(message: AgentMessage): string {
  if ("content" in message && typeof message.content === "string") return stripInteractionReminder(message.content).slice(0, 160);
  if ("content" in message && Array.isArray(message.content)) {
    const text = message.content.find((part) => part && part.type === "text");
    if (text && "text" in text && typeof text.text === "string") return stripInteractionReminder(text.text).slice(0, 160);
  }
  if (message.role === "toolResult") return message.toolName ? `Tool result: ${message.toolName}` : "Tool result";
  if (message.role === "bashExecution") return `$ ${message.command}`.slice(0, 160);
  return message.role;
}

function fullMessageText(message: AgentMessage): string {
  if ("content" in message && typeof message.content === "string") return message.content;
  if ("content" in message && Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part || typeof part !== "object" || !("text" in part)) return "";
        const block = part as { text?: unknown };
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "bashExecution") return `${message.command}\n${message.output}`;
  if (message.role === "pythonExecution") return `${message.code}\n${message.output}`;
  if (message.role === "fileMention") return message.files.map((file) => `${file.path}\n${file.content}`).join("\n");
  return "";
}


export function getLocalReactionTargets(filePath: string): ReactionTarget[] {
  if (!existsSync(filePath)) return [];
  const entries = getSessionEntries(filePath);
  return entries.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
    .slice(-MAX_REACTION_TARGETS)
    .map((entry) => {
      const reminderAlias = extractInteractionAlias(fullMessageText(entry.message));
      return {
        id: entry.id,
        role: entry.message.role,
        ...(typeof entry.message.timestamp === "number" ? { timestamp: entry.message.timestamp } : {}),
        preview: previewMessage(entry.message),
        ...(reminderAlias ? { reminderAlias } : {}),
      };
    });
}



function requireTarget(targets: ReactionTarget[], messageId: string): void {
  if (typeof messageId !== "string" || !messageId || !targets.some((target) => target.id === messageId)) {
    throw new Error("Message target not found in this session");
  }
}

export type ThreadExpressionAction =
  | { action: "react"; messageId: string; emoji: string; actor: ReactionActor }
  | { action: "expression"; expression: string; caption: string }
  | { action: "celebrate"; messageId: string; effect: "confetti" | "sparkles" };

export function updateThreadExpression(id: string, action: ThreadExpressionAction, targets: ReactionTarget[] = []): ThreadExpressionState {
  ensureThreadId(id);
  const current = stateFor(id);
  if (action.action === "expression") {
    if ([...action.expression].length > MAX_EXPRESSION_CODEPOINTS) throw new Error(`Expression must be at most ${MAX_EXPRESSION_CODEPOINTS} code points`);
    if ([...action.caption].length > MAX_CAPTION_CODEPOINTS) throw new Error(`Caption must be at most ${MAX_CAPTION_CODEPOINTS} code points`);
    return commit(id, { ...current, expression: action.expression, caption: action.caption, expressionUpdatedAt: Date.now() });
  }
  requireTarget(targets, action.messageId);
  if (action.action === "celebrate") return commit(id, { ...current, celebration: { id: randomUUID(), messageId: action.messageId, effect: action.effect } });
  if (!isValidEmoji(action.emoji)) throw new Error("Emoji must be one valid emoji grapheme");
  const existing = current.reactions[action.messageId] ? [...current.reactions[action.messageId]] : [];
  const same = existing.findIndex((reaction) => reaction.actor === action.actor && reaction.emoji === action.emoji);
  if (same >= 0) {
    if (action.actor === "user") existing.splice(same, 1);
  } else {
    if (existing.filter((reaction) => reaction.actor === action.actor).length >= MAX_REACTIONS_PER_MESSAGE_PER_ACTOR) throw new Error("Too many reactions on this message");
    existing.push({ emoji: action.emoji, actor: action.actor });
  }
  const reactions = { ...current.reactions };
  if (existing.length) reactions[action.messageId] = existing;
  else delete reactions[action.messageId];
  return commit(id, { ...current, reactions });
}

export const REACT_TO_MESSAGE_TOOL = {
  name: "react_to_message", label: "React to Message", loadMode: "essential" as const,
  description: "React warmly to a user message with an emoji: acknowledge, agree, appreciate, sympathize, or respond playfully. Reactions are welcome alone or alongside a textual answer. Use the current message id from an interaction reminder directly; use list_reaction_targets for other messages. Do not substitute a reaction for required work.",
  parameters: { type: "object", properties: { message_id: { type: "string" }, emoji: { type: "string" } }, required: ["message_id", "emoji"], additionalProperties: false },
};
export const SET_EXPRESSION_TOOL = {
  name: "set_expression", label: "Set Expression", loadMode: "essential" as const,
  description: "Choose an occasional playful kaomoji expression and short thread caption. Keep it natural and modest, never force it every turn, and never use it as a claim of feelings, task status, or a substitute for required work. Set the current expression and caption when they should change; reactions or milestone celebrations are optional. Examples: (・ω・) listening, (ง •̀_•́)ง working, (ᵔᴥᵔ) pleased, (；・∀・) sheepish. Invent your own; keep captions one short line.",
  parameters: { type: "object", properties: { expression: { type: "string", maxLength: MAX_EXPRESSION_CODEPOINTS }, caption: { type: "string", maxLength: MAX_CAPTION_CODEPOINTS } }, required: ["expression", "caption"], additionalProperties: false },
};
export const LIST_REACTION_TARGETS_TOOL = {
  name: "list_reaction_targets", label: "List Reaction Targets", loadMode: "essential" as const,
  description: "List recent actual messages in this thread with ids and short previews when you need to choose a message for reacting or celebrating. Do not call it when an interaction reminder already supplies the current target id.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export const CELEBRATE_TOOL = {
  name: "celebrate", label: "Celebrate", loadMode: "essential" as const,
  description: "Offer a brief celebration attached to a recent actual message only when a meaningful milestone is reached. Use sparingly, not for routine progress; reactions and kaomoji/captions are optional contextual touches, not a checklist. The user controls whether effects display. Use list_reaction_targets when you need to find a target; when an interaction reminder supplies the current id, use it directly.",
  parameters: { type: "object", properties: { message_id: { type: "string" }, effect: { type: "string", enum: ["confetti", "sparkles"] } }, required: ["message_id", "effect"], additionalProperties: false },
};
export const THREAD_EXPRESSION_TOOLS = [REACT_TO_MESSAGE_TOOL, SET_EXPRESSION_TOOL, LIST_REACTION_TARGETS_TOOL, CELEBRATE_TOOL];
export const THREAD_EXPRESSION_TOOL_NAMES = new Set(THREAD_EXPRESSION_TOOLS.map((tool) => tool.name));

export async function handleThreadExpressionTool(
  sessionId: string,
  toolName: string,
  rawArgs: unknown,
  targetResolver: () => ReactionTarget[] | Promise<ReactionTarget[]>,
): Promise<{ content: [{ type: "text"; text: string }] }> {
  if (!THREAD_EXPRESSION_TOOL_NAMES.has(toolName)) throw new Error(`Unknown thread expression tool: ${toolName}`);
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  if (toolName === LIST_REACTION_TARGETS_TOOL.name) return { content: [{ type: "text", text: JSON.stringify(await targetResolver()) }] };
  if (toolName === SET_EXPRESSION_TOOL.name) {
    const expression = typeof args.expression === "string" ? args.expression : "";
    const caption = typeof args.caption === "string" ? args.caption : "";
    updateThreadExpression(sessionId, { action: "expression", expression, caption });
    return { content: [{ type: "text", text: "Expression updated." }] };
  }
  const messageId = typeof args.message_id === "string" ? args.message_id : "";
  const targets = await targetResolver();
  const resolvedMessageId = resolveInteractionAlias(sessionId, messageId, targets);
  if (toolName === REACT_TO_MESSAGE_TOOL.name) {
    const emoji = typeof args.emoji === "string" ? args.emoji : "";
    updateThreadExpression(sessionId, { action: "react", messageId: resolvedMessageId, emoji, actor: "agent" }, targets);
    return { content: [{ type: "text", text: "Reaction updated." }] };
  }
  if (args.effect !== "confetti" && args.effect !== "sparkles") throw new Error("Celebration effect must be confetti or sparkles");
  updateThreadExpression(sessionId, { action: "celebrate", messageId: resolvedMessageId, effect: args.effect }, targets);
  return { content: [{ type: "text", text: "Celebration sent." }] };
}
