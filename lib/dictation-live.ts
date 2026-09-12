/**
 * Live (real-time streaming) dictation — server engine.
 * Opt-in via `OMP_WEB_DICTATION_REALTIME_URL` (a ws:// or wss:// URL). Unset
 * disables the feature; an unparseable value disables it and logs once. The
 * stable-word listener uses `OMP_WEB_DICTATION_PREVIEW_URL`, defaulting to the
 * LAN preview endpoint documented by Bee STT.
 *
 * Wire contract (browser <-> ompweb, same-origin WebSocket; the browser never
 * talks to the upstream endpoint):
 *   GET  /api/dictation/live           -> { enabled: boolean }   (Next route)
 *   WS   /api/dictation/live/socket    -> persistent dictation socket, one
 *                                         fresh upstream connection each
 *     server -> browser: {type:"ready"}         after upstream session.created
 *     browser -> server: binary frame, PCM16 24kHz mono, <=96KiB
 *     browser -> server: {type:"commit"} | {type:"cancel"}
 *     server -> browser: {type:"delta",text} | {type:"completed",text}
 *                        | {type:"error",error}
 *   A terminal completed/error event is followed by a close; cancel closes
 *   without a terminal event. Errors close both sockets.
 *
 * Upstream protocol, observed against the Mac endpoint
 * (`ws://10.10.20.188:8765/v1/realtime`, an OpenAI-realtime-shaped streaming
 * transcription service):
 *   - server -> client: `session.created` carrying
 *     `audio.input.format = { type: "audio/pcm", rate: 24000 }`. The client
 *     sends no configuration — appended audio is PCM16 24k mono.
 *   - client -> server: `{ type: "input_audio_buffer.append", audio: base64 }`
 *     and `{ type: "input_audio_buffer.commit" }`.
 *   - server -> client: `conversation.item.input_audio_transcription.delta`
 *     (field `delta`) streams partial text while the buffer is being filled;
 *     `...completed` (field `transcript`) finalizes shortly after commit; an
 *     `error` event is fatal (the server closes the socket afterwards).
 *
 * Bounds: 16 concurrent connections, 96KiB frames, a 14.4MB (5 min of PCM16
 * 24k mono) per-session capture cap, an upstream send-queue high-water mark
 * with a bounded drain, a 10s connect handshake deadline, a 5 min capture
 * window, and a 60s finalization deadline after commit. The upstream event
 * loop can stall for >1.5s during inference and partials arrive every few
 * seconds — no liveness deadline is imposed on deltas.
 *
 * Provider error payloads are sanitized — browser-facing text never includes
 * upstream message bodies.
 */

import { parseDictationSpans, type DictationDisplayMode, type DictationSpan } from "./dictation-display.ts";

export const REALTIME_URL_ENV = "OMP_WEB_DICTATION_REALTIME_URL";
export const PREVIEW_URL_ENV = "OMP_WEB_DICTATION_PREVIEW_URL";
export const DEFAULT_PREVIEW_URL = "ws://10.10.20.188:8766/v1/realtime";

/** One binary frame is at most two seconds of 24kHz PCM16 mono. */
export const MAX_CHUNK_BYTES = 2 * 24000 * 2;
/** Finite per-session capture cap: 5 min at 48kB/s (24000 Hz * 2 bytes) =
 * 14.4MB. Enforced at enqueue time so queued PCM can never pile up. */
export const MAX_SESSION_BYTES = 5 * 60 * 24000 * 2;
/** Concurrent-connection capacity; extras are refused before/at handshake. */
export const MAX_LIVE_CONNECTIONS = 16;

/** Upper bound for establishing the upstream socket and receiving
 * `session.created` (the readiness handshake). */
const CONNECT_DEADLINE_MS = 10_000;
/** Browser capture window; sessions that never commit expire here. */
const CAPTURE_MS = 5 * 60_000;
/** Bounded finalization after commit (`completed` arrives ~1-2s after
 * commit, but the upstream event loop can stall for seconds). */
const FINALIZE_MS = 60_000;

/** Upstream socket send-queue high-water mark; past it we wait (bounded). */
const BUFFERED_HIGH_WATER = 128 * 1024;
const BACKPRESSURE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RealtimeDictationConfig {
  enabled: boolean;
  /** Immediate upstream URL; never exposed to the browser. */
  url?: string;
  /** Stable-word preview upstream URL; never exposed to the browser. */
  previewUrl?: string;
  /** Modes that can be selected by the browser. */
  supportedDisplayModes: DictationDisplayMode[];
  /** True when an upstream URL setting was invalid. */
  misconfigured: boolean;
}

const misconfigLogged: Record<string, boolean> = {};

function parseUpstreamUrl(raw: string | undefined, envName: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    if (!misconfigLogged[envName]) {
      misconfigLogged[envName] = true;
      console.error(`[dictation-live] ${envName} is not a valid URL; live dictation disabled`);
    }
    return undefined;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    if (!misconfigLogged[envName]) {
      misconfigLogged[envName] = true;
      console.error(`[dictation-live] ${envName} must be ws:// or wss://; live dictation disabled`);
    }
    return undefined;
  }
  return url.toString();
}

export function getRealtimeDictationConfig(): RealtimeDictationConfig {
  const url = parseUpstreamUrl(process.env[REALTIME_URL_ENV], REALTIME_URL_ENV);
  if (!url) return { enabled: false, supportedDisplayModes: [], misconfigured: Boolean(process.env[REALTIME_URL_ENV]?.trim()) };
  const previewUrl = parseUpstreamUrl(process.env[PREVIEW_URL_ENV] ?? DEFAULT_PREVIEW_URL, PREVIEW_URL_ENV);
  return { enabled: true, url, previewUrl, supportedDisplayModes: previewUrl ? ["immediate", "stable_words", "clean_tail"] : ["immediate"], misconfigured: false };
}

// Browser-facing events + socket abstraction
// ---------------------------------------------------------------------------

import { isRecord } from "./type-guards.ts";

/** Events sent to the browser over the live socket. */
export type LiveDictationEvent =
  | { type: "delta"; text: string; itemId?: string }
  | { type: "updated"; text: string; spans?: DictationSpan[]; itemId?: string; final?: boolean }
  | { type: "completed"; text: string; itemId?: string }
  | { type: "error"; error: string };
/**
 * The browser-facing socket, structurally compatible with `ws`'s WebSocket.
 * The engine never depends on a concrete ws implementation.
 */
export interface LiveDictationSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

// ---------------------------------------------------------------------------
// Bridge (one per browser connection)
// ---------------------------------------------------------------------------

/** Node's global WebSocket readyState values (undici). */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

type BridgeState = "connecting" | "ready" | "committed" | "ended";

/** Normal completion/cancel close code. */
const CLOSE_NORMAL = 1000;
/** Any error path closes with this app-defined code. */
const CLOSE_ERROR = 4000;

class LiveDictationBridge {
  readonly browser: LiveDictationSocket;
  state: BridgeState = "connecting";
  private upstream: WebSocket | null = null;
  private bytesUploaded = 0;
  /** Serialized append/commit pipeline; preserves browser frame order. */
  private queue: Promise<void> = Promise.resolve();
  private connectTimer: NodeJS.Timeout | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private finalizeTimer: NodeJS.Timeout | null = null;

  private itemId?: string;
  private readonly displayMode: DictationDisplayMode;
  constructor(browser: LiveDictationSocket, displayMode: DictationDisplayMode = "immediate") {
    this.browser = browser;
    this.displayMode = displayMode;
    browser.on("message", (data, isBinary) => this.onBrowserMessage(data, isBinary));
    browser.on("close", () => this.end(undefined, CLOSE_NORMAL));
    browser.on("error", () => this.end(undefined, CLOSE_NORMAL));
  }

  /** Connect to the upstream endpoint and begin the handshake. */
  start(): void {
    const config = getRealtimeDictationConfig();
    if (!config.enabled || !config.url) {
      this.endWithError(
        config.misconfigured ? "Live dictation is misconfigured" : "Live dictation is not configured",
      );
      return;
    }
    let ws: WebSocket;
    try {
      const url = this.displayMode !== "immediate" ? config.previewUrl : config.url;
      if (!url) throw new Error("Display mode unavailable");
      ws = new WebSocket(url);
    } catch {
      this.endWithError("Live transcription provider unavailable");
      return;
    }
    this.upstream = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "session.update", session: { type: "transcription", ...(this.displayMode !== "immediate" ? { display_mode: this.displayMode } : {}), audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null } } } }));
    });
    ws.addEventListener("message", (ev) => {
      void this.handleUpstreamMessage(ev);
    });
    ws.addEventListener("close", () => this.onUpstreamGone());
    ws.addEventListener("error", () => this.onUpstreamGone());
    this.connectTimer = setTimeout(() => {
      this.endWithError("Live transcription connect timed out");
    }, CONNECT_DEADLINE_MS);
  }

  // -- browser -> engine ----------------------------------------------------

  private onBrowserMessage(data: unknown, isBinary: boolean): void {
    if (this.state === "ended") return;
    if (isBinary) {
      this.appendAudio(data);
      return;
    }
    this.onBrowserText(data);
  }

  private onBrowserText(data: unknown): void {
    let raw: string | null = null;
    if (typeof data === "string") raw = data;
    else if (Buffer.isBuffer(data)) raw = data.toString("utf8");
    if (raw === null) {
      this.endWithError("Invalid message");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.endWithError("Invalid message");
      return;
    }
    if (!isRecord(message)) {
      this.endWithError("Invalid message");
      return;
    }
    if (!("type" in message)) {
      this.endWithError("Invalid message");
      return;
    }
    switch (message.type) {
      case "commit":
        this.commit();
        break;
      case "cancel":
        this.cancel();
        break;
      default:
        this.endWithError("Invalid message");
    }
  }

  /** Strict binary (PCM16) frame intake; bounds enforced at enqueue time. */
  private appendAudio(data: unknown): void {
    if (this.state === "committed" || this.state === "ended") return; // late audio after commit is dropped
    if (this.state !== "ready") {
      this.endWithError("Live dictation is not ready");
      return;
    }
    const bytes = toBuffer(data);
    if (!bytes) {
      this.endWithError("Invalid audio frame");
      return;
    }
    if (bytes.byteLength === 0) {
      this.endWithError("Audio frame is empty");
      return;
    }
    if (bytes.byteLength > MAX_CHUNK_BYTES) {
      this.endWithError("Audio frame is too large");
      return;
    }
    // PCM16 is 2 bytes per sample; an odd frame length is never valid mono 16-bit.
    if (bytes.byteLength % 2 !== 0) {
      this.endWithError("Invalid audio frame");
      return;
    }
    if (this.bytesUploaded + bytes.byteLength > MAX_SESSION_BYTES) {
      this.endWithError("Dictation capture byte limit exceeded");
      return;
    }
    this.bytesUploaded += bytes.byteLength;
    const audio = bytes.toString("base64");
    const run = this.queue.then(async () => {
      if (this.state !== "ready") return;
      const ws = this.upstream;
      if (!ws || ws.readyState !== WS_OPEN) return;
      await drainUpstreamBackpressure(ws);
      try {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      } catch {
        this.endWithError("Live transcription connection closed");
      }
    });
    this.queue = run.catch(() => this.endWithError("Live audio connection stalled"));
  }

  /** Commit the capture buffer. Serialized after every queued append so the
   * upstream sees a complete buffer; a second commit is a no-op. */
  private commit(): void {
    if (this.state === "committed" || this.state === "ended") return;
    if (this.state !== "ready") {
      this.endWithError("Live dictation is not ready");
      return;
    }
    const run = this.queue.then(async () => {
      if (this.state === "ended") return;
      if (this.state !== "ready") return; // already committed -> no double commit
      const ws = this.upstream;
      if (!ws || ws.readyState !== WS_OPEN) {
        this.endWithError("Live transcription connection closed");
        return;
      }
      await drainUpstreamBackpressure(ws);
      try {
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        this.endWithError("Live transcription connection closed");
        return;
      }
      this.state = "committed";
      if (this.captureTimer) {
        clearTimeout(this.captureTimer);
        this.captureTimer = null;
      }
      this.finalizeTimer = setTimeout(() => {
        this.endWithError("Dictation finalization timed out");
      }, FINALIZE_MS);
    });
    this.queue = run.catch(() => this.endWithError("Live audio connection stalled"));
  }

  /** Cancel: end immediately without a terminal event. Always honored. */
  private cancel(): void {
    this.end(undefined, CLOSE_NORMAL);
  }

  // -- upstream -> engine ---------------------------------------------------

  private async handleUpstreamMessage(ev: MessageEvent): Promise<void> {
    try {
      const message = await parseUpstreamMessage(ev);
      if (!message || typeof message.type !== "string") return;
      if (message.type === "conversation.item.added" && isRecord(message.item) && typeof message.item.id === "string") this.itemId = message.item.id;
      if (message.type.startsWith("conversation.item.input_audio_transcription.") && typeof message.item_id === "string") {
        if (this.itemId && message.item_id !== this.itemId) return;
        this.itemId ??= message.item_id;
      }
      switch (message.type) {
        case "session.created":
        case "session.updated":
          if (this.displayMode !== "immediate") {
            if (message.type !== "session.updated") return;
            const session = isRecord(message.session) ? message.session : message;
            if (session.display_mode !== this.displayMode) { this.endWithError("Requested display mode was not accepted"); return; }
          }
          if (this.state !== "connecting") return;
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          this.state = "ready";
          this.captureTimer = setTimeout(() => {
            this.endWithError("Dictation capture window expired");
          }, CAPTURE_MS);
          this.sendBrowser({ type: "ready" });
          break;
        case "conversation.item.input_audio_transcription.delta":
          if (this.displayMode === "immediate" && typeof message.delta === "string" && message.delta.length > 0) {
            this.sendBrowser({ type: "delta", text: message.delta });
          }
          break;
        case "conversation.item.input_audio_transcription.correction":
        case "conversation.item.input_audio_transcription.updated":
          if (typeof message.transcript === "string") this.sendBrowser({type:"updated",text:message.transcript,spans:parseDictationSpans(message.spans,message.transcript),itemId:typeof message.item_id === "string" ? message.item_id : undefined,final:message.final === true});
          break;
        case "conversation.item.input_audio_transcription.completed":
          this.end(
            { type: "completed", text: typeof message.transcript === "string" ? message.transcript : "" },
            CLOSE_NORMAL,
          );
          break;
        case "error":
          // Fatal on the upstream side (the server closes afterwards). Payload
          // is provider-owned; never forward it.
          this.endWithError("Live transcription provider error");
          break;
        default:
          // input_audio_buffer.committed, conversation.item.added, VAD events —
          // nothing for the browser to see.
          break;
      }
    } catch {
      this.endWithError("Live transcription provider error");
    }
  }

  /** Upstream socket closed or errored before an intentional end. */
  private onUpstreamGone(): void {
    if (this.state === "ended") return;
    if (this.state === "connecting") {
      this.endWithError("Live transcription provider unavailable");
      return;
    }
    this.endWithError("Transcription connection closed");
  }

  // -- terminal paths -------------------------------------------------------

  private sendBrowser(event: LiveDictationEvent | { type: "ready" }): void {
    try {
      this.browser.send(JSON.stringify(event));
    } catch {
      // Browser already gone; the close handler will end the bridge.
      if (this.state !== "ended") {
        this.end(undefined, CLOSE_NORMAL);
      }
    }
  }

  private endWithError(error: string): void {
    this.end({ type: "error", error }, CLOSE_ERROR);
  }

  /** Terminal transition, idempotent: deliver the optional event, then close
   * the upstream and browser sockets (queued frames flush before the close
   * frame), clear timers, and release the connection slot. Not private:
   * attachLiveDictationSocket's failure path releases a reserved slot. */
  end(event: LiveDictationEvent | undefined, closeCode: number): void {
    if (this.state === "ended") return;
    this.state = "ended";
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (event) this.sendBrowser(event);
    const ws = this.upstream;
    this.upstream = null;
    if (ws) {
      try {
        if (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN) ws.close(closeCode);
      } catch {
        // Socket already gone.
      }
    }
    try {
      this.browser.close(closeCode);
    } catch {
      // Already closed.
    }
    bridges.delete(this);
    activeConnections -= activeConnections > 0 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level connection accounting
// ---------------------------------------------------------------------------

const bridges = new Set<LiveDictationBridge>();
let activeConnections = 0;

/** Live bridge count (connecting + ready + committed); the server uses it to
 * refuse upgrades past capacity before completing the handshake. */
export function getActiveLiveConnectionCount(): number {
  return activeConnections;
}

/** Attach a browser socket to a fresh upstream bridge. The connection slot is
 * reserved synchronously; an oversubscribed attach closes with 1013. */
export function attachLiveDictationSocket(socket: LiveDictationSocket, displayMode: DictationDisplayMode = "immediate"): void {
  if (activeConnections >= MAX_LIVE_CONNECTIONS) {
    try {
      socket.send(JSON.stringify({ type: "error", error: "Too many live dictation connections" }));
    } catch {
      // Socket already dead; just close.
    }
    try {
      socket.close(1013, "Too many connections");
    } catch {
      // Already closed.
    }
    return;
  }
  const bridge = new LiveDictationBridge(socket, displayMode);
  bridges.add(bridge);
  activeConnections += 1;
  try {
    bridge.start();
  } catch (error) {
    // Never leak a reserved slot; end() releases it.
    bridge.end(undefined, CLOSE_NORMAL);
    console.error("[dictation-live] failed to start bridge:", error);
  }
}

/** Shutdown hook: end every live bridge (closes both sockets). */
export function closeAllLiveConnections(): void {
  for (const bridge of [...bridges]) {
    bridge.end(undefined, CLOSE_NORMAL);
  }
}

// ---------------------------------------------------------------------------
// Upstream helpers
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

async function parseUpstreamMessage(ev: MessageEvent): Promise<Record<string, unknown> | null> {
  const data = ev.data;
  let raw: string;
  if (typeof data === "string") {
    raw = data;
  } else if (data instanceof ArrayBuffer) {
    raw = Buffer.from(data).toString("utf8");
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    raw = await data.text();
  } else {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Wait (bounded) for the upstream socket's send queue to drain below the
 * high-water mark so chunks cannot pile up unboundedly. */
async function drainUpstreamBackpressure(ws: WebSocket): Promise<void> {
  const deadline = Date.now() + BACKPRESSURE_TIMEOUT_MS;
  while (ws.bufferedAmount > BUFFERED_HIGH_WATER) {
    if (Date.now() > deadline) throw new Error("upstream send queue stalled");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}