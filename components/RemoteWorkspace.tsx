"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CircleAlert, Cloud, LoaderCircle, RefreshCw } from "lucide-react";
import type { AgentMessage } from "@/lib/types";
import { isRecord } from "@/lib/type-guards";
import { normalizeToolCalls } from "@/lib/normalize";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import type { RemoteControls } from "@/lib/remote-controls";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "./ChatInput";
import { parseActiveGoal } from "@/lib/web-mode-state";
import { useAudio } from "@/hooks/useAudio";
import { CommittedTranscript } from "./CommittedTranscript";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./ui/primitives";
import { ComposerPanels } from "./ComposerPanels";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import { parseSubagentSnapshot, type SubagentInfo } from "@/lib/subagent-types";
type RemoteSession = {
  id: string;
  targetId: string;
  remoteSessionId: string;
  name: string;
  cwd: string;
  connected: boolean;
};

type RemoteDetail = {
  revision?: number;
  streamId?: string;
  session: RemoteSession;
  messages: AgentMessage[];
  /** Absolute index of messages[0] in the remote transcript. */
  startIndex: number;
  totalMessages: number;
  hasMore: boolean;
  running: boolean;
  error?: string;
};

type RemotePage = {
  revision?: number;
  streamId?: string;
  messages: AgentMessage[];
  startIndex: number;
  totalMessages: number;
  hasMore: boolean;
};

type ApiPayload = {
  success?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  session?: RemoteSession;
  messages?: unknown;
  totalMessages?: unknown;
  startIndex?: unknown;
  hasMore?: unknown;
  running?: boolean;
};

type RemoteEventFrame = {
  revision?: number;
  streamId?: string;
  messageIndex?: number;
  type?: string;
  controls?: RemoteControls;
  session?: RemoteSession;
  messages?: unknown;
  totalMessages?: unknown;
  startIndex?: unknown;
  hasMore?: unknown;
  running?: boolean;
  error?: string;
  event?: Record<string, unknown>;
};

const REMOTE_CACHE_LIMIT = 8;
const REMOTE_PAGE_SIZE = 100;
const remoteDetailCache = new Map<string, RemoteDetail>();

function cacheRemoteDetail(id: string, detail: RemoteDetail): void {
  remoteDetailCache.delete(id);
  remoteDetailCache.set(id, detail);
  while (remoteDetailCache.size > REMOTE_CACHE_LIMIT) {
    const oldest = remoteDetailCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    remoteDetailCache.delete(oldest);
  }
}

function payloadRecord(payload: ApiPayload | RemoteEventFrame): Record<string, unknown> {
  const data = "data" in payload ? payload.data : undefined;
  if (isRecord(data)) return data;
  return payload as unknown as Record<string, unknown>;
}

function normalizePage(payload: ApiPayload | RemoteEventFrame, fallbackStartIndex = 0): RemotePage {
  const data = payloadRecord(payload);
  const messages = normalizeMessages(data.messages);
  const totalValue = data.totalMessages;
  const explicitTotal = typeof totalValue === "number" && Number.isFinite(totalValue) && totalValue >= 0
    ? Math.floor(totalValue)
    : undefined;
  const startValue = data.startIndex;
  const explicitStart = typeof startValue === "number" && Number.isFinite(startValue) && startValue >= 0
    ? Math.floor(startValue)
    : undefined;
  const totalMessages = Math.max(explicitTotal ?? (explicitStart ?? fallbackStartIndex) + messages.length, messages.length);
  const startIndex = explicitStart ?? (explicitTotal !== undefined ? Math.max(0, explicitTotal - messages.length) : fallbackStartIndex);
  const hasMoreValue = data.hasMore;
  const hasMore = typeof hasMoreValue === "boolean" ? hasMoreValue : startIndex > 0;
  return { messages, startIndex, totalMessages, hasMore, revision: typeof data.revision === "number" ? data.revision : undefined, streamId: typeof data.streamId === "string" ? data.streamId : undefined };
}

function mergeRemotePage(current: RemoteDetail | null, page: RemotePage, session: RemoteSession, running: boolean, error?: string, older = false): RemoteDetail {
  if (older && current && current.streamId !== page.streamId) return current;
  if (current?.streamId && page.streamId && current.streamId !== page.streamId) return { session, ...page, running, ...(error ? { error } : {}) };
  if (!older && current && current.streamId === page.streamId && (page.revision ?? 0) < (current.revision ?? 0)) return current;
  const existingStart = current?.startIndex ?? page.startIndex;
  const existingMessages = current?.messages ?? [];
  const existingEnd = existingStart + existingMessages.length;
  const incomingEnd = page.startIndex + page.messages.length;
  if (older && current && (incomingEnd < existingStart || page.totalMessages < existingStart)) return current;
  if (page.startIndex > existingEnd || incomingEnd < existingStart || page.totalMessages < existingStart) {
    return { session, ...page, running, ...(error ? {error} : {}) };
  }
  const startIndex = Math.min(existingStart, page.startIndex);
  const endIndex = older ? Math.max(existingEnd, incomingEnd) : Math.min(Math.max(existingEnd, incomingEnd), page.totalMessages);
  const byIndex = new Map<number, AgentMessage>();
  existingMessages.forEach((message, index) => byIndex.set(existingStart + index, message));
  // Fresh snapshots/pages win for overlapping absolute indexes.
  page.messages.forEach((message, index) => { const absolute = page.startIndex + index; if (!older || !byIndex.has(absolute)) byIndex.set(absolute, message); });
  const messages: AgentMessage[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const message = byIndex.get(index);
    if (message) messages.push(message);
  }
  const totalMessages = older ? Math.max(current?.totalMessages ?? 0, page.totalMessages) : page.totalMessages;
  return {
    session,
    revision: older ? current?.revision : page.revision,
    streamId: page.streamId,
    messages,
    startIndex,
    totalMessages,
    hasMore: page.hasMore || startIndex > 0,
    running,
    ...(error ? { error } : {}),
  };
}

function upsertRemoteMessage(detail: RemoteDetail, index: number, message: AgentMessage): RemoteDetail {
  const currentStart = detail.startIndex;
  const currentEnd = currentStart + detail.messages.length;
  const targetIndex = Math.max(currentStart, Math.min(index, currentEnd));
  const messages = detail.messages.slice();
  if (targetIndex === currentEnd) messages.push(message);
  else messages[targetIndex - currentStart] = message;
  return {
    ...detail,
    messages,
    totalMessages: Math.max(detail.totalMessages, targetIndex + 1),
    hasMore: detail.hasMore || currentStart > 0,
  };
}



export interface RemoteChatProps {
  /** The persisted local wrapper session, or null to create one on first send. */
  sessionId: string | null;
  /** Configured SSH target selected by the parent sidebar. */
  targetId: string;
  /** Called only after a newly-created session has accepted its first prompt. */
  onSessionCreated: (id: string) => void;
  onControlsChange?: (controls: RemoteControls | null) => void;
  onConnectionChange?: (state: "connecting" | "connected" | "reconnecting" | "disconnected") => void;
}


function extractSession(payload: ApiPayload): RemoteSession | null {
  const raw: unknown = isRecord(payload.data) ? payload.data : payload;
  const data = isRecord(raw) ? raw : {};
  const rawSession = data.session;
  const session = isRecord(rawSession) ? rawSession : data;
  if (
    typeof session.id !== "string" ||
    typeof session.targetId !== "string" ||
    typeof session.remoteSessionId !== "string" ||
    typeof session.cwd !== "string"
  ) return null;
  return {
    id: session.id,
    targetId: session.targetId,
    remoteSessionId: session.remoteSessionId,
    name: typeof session.name === "string" && session.name ? session.name : session.remoteSessionId,
    cwd: session.cwd,
    connected: session.connected === true,
  };
}

function extractError(payload: ApiPayload, status: number): string {
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  if (typeof payload.code === "string" && payload.code.trim()) return `${payload.code} (HTTP ${status})`;
  return `Remote request failed (HTTP ${status})`;
}

async function readApi(response: Response): Promise<ApiPayload> {
  const payload = await response.json().catch(() => ({})) as ApiPayload;
  if (!response.ok) throw new Error(extractError(payload, response.status));
  return payload;
}
function normalizeMessages(messages: unknown): AgentMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(isRecord)
    .map((message) => normalizeToolCalls(message as unknown as AgentMessage));
}


/**
 * The remote transcript/composer pane. Target and session navigation belong to
 * AppShell's sidebar; this component owns only the selected session's
 * connection, event stream, history, and prompt lifecycle.
 */
export function RemoteChat({ sessionId, targetId, onSessionCreated, onControlsChange, onConnectionChange }: RemoteChatProps) {
  const { playDoneSound, unlockAudio } = useAudio();
  const composerRef = useRef<ChatInputHandle>(null);
  const editContent = useCallback((text: string) => composerRef.current?.insertIfEmpty(text), []);
  const [localSession, setLocalSession] = useState<RemoteSession | null>(null);
  const [detail, setDetail] = useState<RemoteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [historyWaiting, setHistoryWaiting] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  useEffect(() => { onConnectionChange?.(connectionState); }, [connectionState, onConnectionChange]);
  const [streamRetry, setStreamRetry] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const commandInFlightRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const olderLoadingRef = useRef(false);
  const pendingScrollRestoreRef = useRef<{ top: number; height: number } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const detailRef = useRef<RemoteDetail | null>(null);
  const activeSessionId = sessionId ?? localSession?.id ?? null;
  activeSessionIdRef.current = activeSessionId;
  const [controls, setControls] = useState<RemoteControls | null>(null);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentInfo | null>(null);
  const [branchEntries, setBranchEntries] = useState<Array<{ entryId: string; text: string }>>([]);
  const loadBranchEntries = async () => {
    if (!activeSessionId) return;
    try {
      const response = await fetch(`/api/remote/${encodeURIComponent(activeSessionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "get_branch_messages" }) });
      if (!response.ok) throw new Error("Remote branch history unavailable");
      const data = await response.json();
      setBranchEntries(Array.isArray(data.messages) ? data.messages.filter((entry: { entryId?: unknown; text?: unknown }) => typeof entry.entryId === "string" && typeof entry.text === "string") : []);
    } catch (cause) { setError(String(cause)); }
  };
  const forkFromEntry = async (entryId: string) => {
    if (!activeSessionId || commandInFlightRef.current) return;
    commandInFlightRef.current = true;
    setCommandBusy(true);
    try {
      const response = await fetch(`/api/remote/${encodeURIComponent(activeSessionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fork", entryId }) });
      if (!response.ok) throw new Error("Remote fork failed");
      const data = await response.json();
      onSessionCreated(data.session.id);
    } catch (cause) { setError(String(cause)); }
    finally { commandInFlightRef.current = false; setCommandBusy(false); }
  };
  useEffect(() => {
    setSubagents([]);
    setSelectedSubagent(null);
    if (!activeSessionId) return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/api/remote/${encodeURIComponent(activeSessionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "get_subagents" }) });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && Array.isArray(data.subagents)) setSubagents(data.subagents.map(parseSubagentSnapshot).filter((item: SubagentInfo | undefined): item is SubagentInfo => Boolean(item)));
      } catch {}
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeSessionId]);
  useEffect(() => { onControlsChange?.(controls); }, [controls, onControlsChange]);
  useEffect(() => () => onControlsChange?.(null), [onControlsChange]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [detail?.messages, detail?.running]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    pendingScrollRestoreRef.current = null;
    node.scrollTop = restore.top + (node.scrollHeight - restore.height);
  }, [detail?.messages]);

  const updateControl = useCallback(async (command: Record<string, string>) => {
    if (!activeSessionId) return;
    if (command.type === "compact") setControls(current => current ? { ...current, isCompacting: true } : current);
    try {
      const response = await fetch(`/api/remote/${activeSessionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      if (!response.ok) throw new Error("Remote setting update failed");
      const next = await response.json();
      if (activeSessionIdRef.current === activeSessionId) setControls(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remote setting failed");
      if (command.type === "compact") setControls(current => current ? { ...current, isCompacting: false } : current);
    }
  }, [activeSessionId]);

  useEffect(() => {
    setControls(null);
    if (!activeSessionId) return;
    const refresh = () => { if (document.visibilityState === "visible") void updateControl({ type: "get_controls" }); };
    refresh();
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [activeSessionId, updateControl]);
  detailRef.current = detail;

  useEffect(() => {
    if (sessionId) {
      setLocalSession(null);
      return;
    }
    setLocalSession((current) => current && current.targetId === targetId ? current : null);
  }, [sessionId, targetId]);

  const loadDetail = useCallback(async (id: string, showSpinner = true): Promise<RemoteDetail | null> => {
    if (showSpinner) setDetailLoading(true);
    try {
      const payload = await readApi(await fetch(`/api/remote/${encodeURIComponent(id)}?limit=${REMOTE_PAGE_SIZE}`, { cache: "no-store" }));
      const session = extractSession(payload);
      if (!session) throw new Error("Remote session response was invalid");
      const page = normalizePage(payload);
      const current = activeSessionIdRef.current === id ? detailRef.current : null;
      const nextDetail = mergeRemotePage(current, page, session, payload.running === true, typeof payload.error === "string" ? payload.error : undefined);
      if (activeSessionIdRef.current === id) {
        detailRef.current = nextDetail;
        setDetail(nextDetail);
        cacheRemoteDetail(id, nextDetail);
        if (nextDetail.error) setError(nextDetail.error);
        else if (nextDetail.session.connected) setError(null);
      }
      return nextDetail;
    } catch (reason) {
      if (activeSessionIdRef.current === id) setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      if (showSpinner) setDetailLoading(false);
    }
  }, []);
  useEffect(() => {
    const onRenamed = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (id && id === activeSessionIdRef.current) void loadDetail(id, false);
    };
    window.addEventListener("nook:remote-thread-renamed", onRenamed);
    return () => window.removeEventListener("nook:remote-thread-renamed", onRenamed);
  }, [loadDetail]);

  const loadOlder = useCallback(async () => {
    const id = activeSessionIdRef.current;
    const current = detailRef.current;
    if (!id || !current?.hasMore || current.startIndex <= 0 || olderLoadingRef.current || (historyWaiting && current.running)) return;
    olderLoadingRef.current = true;
    const node = scrollRef.current;
    if (node) pendingScrollRestoreRef.current = { top: node.scrollTop, height: node.scrollHeight };
    followRef.current = false;
    setOlderLoading(true);
    try {
      const before = current.startIndex;
      const response = await fetch(`/api/remote/${encodeURIComponent(id)}?before=${before}&limit=${REMOTE_PAGE_SIZE}`, { cache: "no-store" });
      if (response.status === 409) { const conflict = await response.clone().json(); if (conflict.code === "history_busy") { pendingScrollRestoreRef.current = null; setHistoryWaiting(true); return; } }
      const payload = await readApi(response);
      setHistoryWaiting(false);
      const session = extractSession(payload);
      if (!session) throw new Error("Remote history response was invalid");
      const page = normalizePage(payload, Math.max(0, before - REMOTE_PAGE_SIZE));
      if (activeSessionIdRef.current !== id) return;
      setDetail((latest) => {
        if (!latest) return latest;
        const merged = mergeRemotePage(latest, page, session, latest.running, latest.error, true);
        detailRef.current = merged;
        cacheRemoteDetail(id, merged);
        return merged;
      });
    } catch (reason) {
      pendingScrollRestoreRef.current = null;
      if (activeSessionIdRef.current === id) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      olderLoadingRef.current = false;
      setOlderLoading(false);
    }
  }, [historyWaiting]);


  const connectSession = useCallback(async (id: string): Promise<boolean> => {
    if (commandInFlightRef.current) return false;
    commandInFlightRef.current = true;
    setCommandBusy(true);
    setError(null);
    try {
      const payload = await readApi(await fetch(`/api/remote/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "connect" }) }));
      const session = extractSession(payload);
      if (!session) throw new Error("Remote connection response was invalid");
      const page = normalizePage(payload);
      const current = detailRef.current;
      const nextDetail = mergeRemotePage(current, page, session, payload.running === true, typeof payload.error === "string" ? payload.error : undefined);
      if (activeSessionIdRef.current === id) {
        detailRef.current = nextDetail;
        setDetail(nextDetail);
        cacheRemoteDetail(id, nextDetail);
      }
      if (!session.connected) throw new Error("Remote session is disconnected");
      return true;
    } catch (reason) {
      if (activeSessionIdRef.current === id) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      commandInFlightRef.current = false;
      setCommandBusy(false);
    }
  }, []);

  // Render a warm cached page immediately, then refresh only the bounded latest
  // page. A revisit never waits for the remote transcript before showing UI.
  useEffect(() => {
    const id = activeSessionId;
    pendingScrollRestoreRef.current = null;
    followRef.current = true;
    if (!id) {
      detailRef.current = null;
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    const cached = remoteDetailCache.get(id);
    if (cached) {
      remoteDetailCache.delete(id);
      remoteDetailCache.set(id, cached);
      detailRef.current = cached;
      setDetail(cached);
      setDetailLoading(false);
    } else {
      detailRef.current = null;
      setDetail(null);
      setDetailLoading(true);
    }
    setError(null);
    void (async () => {
      const loaded = await loadDetail(id, !cached);
      if (cancelled || !loaded || loaded.session.connected) return;
      await connectSession(id);
    })();
    return () => { cancelled = true; };
  }, [activeSessionId, connectSession, loadDetail]);
  useEffect(() => {
    if (!activeSessionId) return;
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      setStreamRetry(value => value + 1);
      void loadDetail(activeSessionId, false);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => { document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [activeSessionId, loadDetail]);

  const applyIncrementalEvent = useCallback((id: string, event: Record<string, unknown>, metadata: RemoteEventFrame) => {
    if (activeSessionIdRef.current !== id) return;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "web_goal_updated") {
      setControls(current => current ? { ...current, goal: parseActiveGoal(event.goal) } : current);
      return;
    }
    let current = detailRef.current;
    if (!current) return;
    if (metadata.streamId && current.streamId && metadata.streamId !== current.streamId) return;
    if (typeof metadata.revision === "number" && metadata.revision <= (current.revision ?? -1)) return;
    current = { ...current, revision: metadata.revision ?? current.revision, streamId: metadata.streamId ?? current.streamId };
    if (type === "agent_start") {
      const next = { ...current, running: true };
      detailRef.current = next;
      setDetail(next);
      cacheRemoteDetail(id, next);
      return;
    }
    if (type === "agent_end") {
      if (event.isTerminal === false) return;
      if (current.running) playDoneSound();
      const next = { ...current, running: false };
      detailRef.current = next;
      setDetail(next);
      cacheRemoteDetail(id, next);
      return;
    }
    const rawMessage = event.message;
    if (!isRecord(rawMessage) || typeof rawMessage.role !== "string") return;
    const message = normalizeToolCalls(rawMessage as unknown as AgentMessage);
    const index = metadata.messageIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < current.startIndex || index > current.startIndex + current.messages.length) return;
    const next = upsertRemoteMessage(current, index, message);
    detailRef.current = next;
    setDetail(next);
    cacheRemoteDetail(id, next);
  }, [playDoneSound]);

  // SSE snapshots are bounded latest pages; merge them into any older pages
  // already fetched. Event frames update the streaming tail directly instead
  // of causing a full transcript request per token.
  useEffect(() => {
    const id = activeSessionId;
    const previous = eventSourceRef.current;
    previous?.close();
    eventSourceRef.current = null;
    if (!id) return;
    setConnectionState(streamRetry ? "reconnecting" : "connecting");
    const source = new EventSource(`/api/remote/${encodeURIComponent(id)}/events?retry=${streamRetry}`);
    eventSourceRef.current = source;
    let closed = false;
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as RemoteEventFrame;
        if (frame.type === "snapshot" && frame.session && activeSessionIdRef.current === id) {
          if (frame.controls) setControls(frame.controls);
          const page = normalizePage(frame);
          const current = detailRef.current;
          const next = mergeRemotePage(current, page, frame.session, frame.running === true, typeof frame.error === "string" ? frame.error : undefined);
          detailRef.current = next;
          setDetail(next);
          cacheRemoteDetail(id, next);
          if (next.session.connected) { setError(null); setConnectionState("connected"); }
          else setConnectionState("disconnected");
          if (!next.session.connected && next.error) setError(next.error);
        } else if (frame.type === "event" && frame.event) {
          applyIncrementalEvent(id, frame.event, frame);
        } else if (frame.type === "error") {
          setError(typeof frame.error === "string" ? frame.error : "Remote event stream failed");
        }
      } catch {
        setError("Remote event stream returned invalid data. Retry to reconnect.");
      }
    };
    source.onopen = () => { if (!closed) { setConnectionState("connected"); void loadDetail(id, false); } };
    source.onerror = () => { if (!closed) setConnectionState("reconnecting"); };
    return () => {
      closed = true;
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [activeSessionId, applyIncrementalEvent, streamRetry, loadDetail]);

  const command = useCallback(async (type: "connect" | "abort"): Promise<boolean> => {
    const id = activeSessionIdRef.current;
    if (!id || commandInFlightRef.current) return false;
    commandInFlightRef.current = true;
    setCommandBusy(true);
    setError(null);
    try {
      const payload = await readApi(await fetch(`/api/remote/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) }));
      if (type === "connect") {
        const session = extractSession(payload);
        if (!session) throw new Error("Remote connection response was invalid");
        const page = normalizePage(payload);
        const next = mergeRemotePage(detailRef.current, page, session, payload.running === true, typeof payload.error === "string" ? payload.error : undefined);
        detailRef.current = next;
        setDetail(next);
        cacheRemoteDetail(id, next);
      } else {
        setDetail((current) => current ? { ...current, running: false } : current);
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      commandInFlightRef.current = false;
      setCommandBusy(false);
    }
  }, []);

  const sendToSession = useCallback(async (id: string, message: string, images?: AttachedImage[]): Promise<boolean> => {
    if (commandInFlightRef.current) return false;
    commandInFlightRef.current = true;
    setCommandBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { type: "submit", message };
      if (images?.length) body.images = images.map(({ data: imageData, mimeType }) => ({ data: imageData, mimeType }));
      await readApi(await fetch(`/api/remote/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      commandInFlightRef.current = false;
      setCommandBusy(false);
    }
  }, []);

  const send = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    if ((!message.trim() && !images?.length) || !targetId || commandInFlightRef.current) return false;
    let id = activeSessionIdRef.current;
    let created = false;
    if (!id) {
      commandInFlightRef.current = true;
      setCommandBusy(true);
      setError(null);
      try {
        const payload = await readApi(await fetch("/api/remote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId }) }));
        const session = extractSession(payload);
        if (!session) throw new Error("Remote session creation returned an invalid session");
        id = session.id;
        created = true;
        setLocalSession(session);
        const page = normalizePage(payload);
        const next = mergeRemotePage(null, page, session, payload.running === true, typeof payload.error === "string" ? payload.error : undefined);
        detailRef.current = next;
        setDetail(next);
        cacheRemoteDetail(id, next);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        commandInFlightRef.current = false;
        setCommandBusy(false);
        return false;
      }
      commandInFlightRef.current = false;
      setCommandBusy(false);
    }
    if (!id) return false;
    const accepted = await sendToSession(id, message, images);
    if (accepted && created) setTimeout(() => onSessionCreated(id), 0);
    return accepted;
  }, [onSessionCreated, sendToSession, targetId]);

  const interruptAndReply = useCallback((message: string, images?: AttachedImage[]) => {
    const id = activeSessionIdRef.current;
    if (!id) return Promise.resolve(false);
    return sendToSession(id, message, images).then((accepted) => {
      if (accepted && !sessionId) onSessionCreated(id);
      return accepted;
    });
  }, [onSessionCreated, sendToSession, sessionId]);

  const retry = useCallback(() => {
    setError(null);
    setStreamRetry((value) => value + 1);
    const id = activeSessionIdRef.current;
    if (!id) return;
    void (async () => {
      const loaded = await loadDetail(id);
      if (loaded && !loaded.session.connected) await connectSession(id);
    })();
  }, [connectSession, loadDetail]);

  const abort = useCallback(() => {
    if (detailRef.current?.running) void command("abort");
  }, [command]);


  const connected = detail?.session.connected === true;
  const [threadControlsOpen, setThreadControlsOpen] = useState(false);
  useEffect(() => {
    const open = () => setThreadControlsOpen(true);
    window.addEventListener("nook:thread-controls", open);
    return () => window.removeEventListener("nook:thread-controls", open);
  }, []);
  const isStreaming = detail?.running === true;
  const composerDraftKey = activeSessionId ?? (targetId ? `new:${targetId}` : undefined);
  const sessionLabel = detail?.session.name || detail?.session.remoteSessionId || (activeSessionId ? "Remote session" : "New session");

  return (
    <section style={styles.root} aria-label="Remote conversation">
      <Dialog open={threadControlsOpen} onOpenChange={setThreadControlsOpen}><DialogContent>
        <DialogTitle>{sessionLabel}</DialogTitle><DialogClose />
        <p>{targetId} · {detail?.session.cwd} · {connected ? "Connected" : "Disconnected"}</p>
        <button type="button" disabled={commandBusy || isStreaming} onClick={() => void loadBranchEntries()}>Fork from message</button>
        {branchEntries.map(entry => <button key={entry.entryId} type="button" disabled={commandBusy || isStreaming} onClick={() => void forkFromEntry(entry.entryId)} style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.text}</button>)}
        <details><summary>System prompt</summary><pre style={{ whiteSpace: "pre-wrap" }}>{controls?.systemPrompt || "Not reported by remote host"}</pre></details>
        <p>Remote file browsing, deletion, and in-thread tree navigation are not supported by this connection. Fork creates a separate thread; the original is preserved.</p>
      </DialogContent></Dialog>

      {error && <div role="alert" style={styles.error}><CircleAlert size={14} aria-hidden="true" /><span style={{ flex: 1 }}>{error}</span><button type="button" onClick={retry} style={styles.retryButton}><RefreshCw size={13} /> Retry</button></div>}

      <div ref={scrollRef} onScroll={event => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; if (node.scrollTop < 180 && detailRef.current?.hasMore) void loadOlder(); }} style={styles.messages}>
        <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
          {detail?.hasMore && <button type="button" onClick={() => void loadOlder()} disabled={olderLoading || (historyWaiting && isStreaming)} style={styles.loadOlder}>{historyWaiting && isStreaming ? "Older history waits for this response to finish" : olderLoading ? "Loading older messages…" : "Load older messages"}</button>}
          {detailLoading && !detail ? (
            <div role="status" style={styles.centerState}><LoaderCircle size={18} className="animate-spin" /> Loading remote session…</div>
          ) : detail && detail.messages.length > 0 ? (
            <CommittedTranscript handleEditContent={editContent} messages={detail.messages} messageIndexOffset={detail.startIndex} sessionId={detail.session.id} messageCwd={detail.session.cwd} isStreaming={isStreaming} sessionBusy={isStreaming} toolCallsDefaultCollapsed />
          ) : (
            <div style={styles.centerState}><Cloud size={20} color="var(--accent)" aria-hidden="true" /><strong>{activeSessionId ? `Ready on ${targetId || "remote host"}` : `Start a session on ${targetId || "a remote host"}`}</strong><span style={styles.muted}>{activeSessionId ? "Send a prompt to continue this remote session." : "Your first prompt will create the remote session."}</span></div>
          )}
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto", padding: "0 16px" }}><ComposerPanels todoPhases={controls?.todoPhases ?? []} subagents={subagents} onSelectSubagent={setSelectedSubagent} busy={isStreaming || controls?.isCompacting} /></div>
      <SubagentTranscriptDialog remote subagent={selectedSubagent} sessionId={activeSessionId} transcriptVersion={0} onClose={() => setSelectedSubagent(null)} />
      <div style={{ ...styles.composer, width: "100%", maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}><ChatInput ref={composerRef} onSend={send} onAbort={abort} onInterruptAndReply={interruptAndReply} isStreaming={isStreaming} draftKey={composerDraftKey} model={controls?.model} modelList={controls?.models} modelNameOverride={controls?.model?.name} onModelChange={(provider, modelId) => void updateControl({ type: "set_model", provider, modelId })} thinkingLevel={controls?.thinkingLevel} onThinkingLevelChange={level => void updateControl({ type: "set_thinking_level", level })} contextUsage={controls?.contextUsage} isCompacting={controls?.isCompacting} onCompact={activeSessionId ? () => void updateControl({ type: "compact" }) : undefined} onAbortCompaction={() => void updateControl({ type: "abort_compaction" })} activeGoal={controls?.goal} onAudioUnlock={unlockAudio} /></div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, height: "100%", background: "var(--bg)", color: "var(--text)" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 45, padding: "8px 18px", flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" },
  identity: { display: "flex", alignItems: "center", gap: 7, minWidth: 0, overflow: "hidden", fontSize: 12 },
  statusDot: { width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%" },
  sessionName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 650 },
  host: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 11 },
  cwd: { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 },
  connection: { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 10.5, whiteSpace: "nowrap" },
  error: { display: "flex", alignItems: "center", gap: 8, margin: "10px 18px 0", padding: "8px 10px", color: "var(--status-error)", background: "color-mix(in srgb, var(--status-error) 7%, var(--bg-panel))", border: "1px solid color-mix(in srgb, var(--status-error) 30%, var(--border))", borderRadius: "var(--radius-control)", fontSize: 12, lineHeight: 1.4 },
  retryButton: { display: "inline-flex", alignItems: "center", gap: 5, minHeight: 26, padding: "0 8px", color: "inherit", background: "transparent", border: "1px solid color-mix(in srgb, var(--status-error) 40%, var(--border))", borderRadius: "var(--radius-control)", font: "inherit", fontSize: 11, cursor: "pointer" },
  messages: { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "20px 16px" },
  loadOlder: { display: "block", margin: "0 auto 12px", minHeight: 30, padding: "0 12px", color: "var(--text-muted)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", font: "inherit", fontSize: 11, cursor: "pointer" },
  running: { display: "flex", alignItems: "center", gap: 7, marginTop: 10, color: "var(--text-muted)", fontSize: 12 },
  liveDot: { width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" },
  composer: { flexShrink: 0 },
  centerState: { minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 9, padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 13 },
  muted: { color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 },
};
