import type { DictationSpan } from "./dictation-display";
import { createLiveSession, LiveDictationSession, MAX_LIVE_QUEUE_BYTES } from "./dictation-live-client";

type TimerHandle = ReturnType<typeof setTimeout>;
export class AudioCaptureError extends Error {
  constructor(message: string) { super(message); this.name = "AudioCaptureError"; }
}

async function audioStep(operation: Promise<unknown>, label: string) {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new AudioCaptureError(`${label} timed out`)), 2000);
  try { await Promise.race([operation, deadline.promise]); } finally { clearTimeout(timer); }
}

export class LiveCapture {
  readonly pcm: Uint8Array<ArrayBuffer>[] = [];
  private bytes = 0;
  private queued = 0;
  private failure: Error | null = null;
  private session?: LiveDictationSession;
  private events = new AbortController();
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private context?: AudioContext;
  private flushed?: () => void;
  private result?: Promise<string>;
  private rejectResult?: (error: Error) => void;
  private connection?: Promise<void>;
  private connected = false;
  private cancelled = false;
  private stopping = false;
  private finishPromise?: Promise<string>;
  private processorFailed = false;
  private clockStart = 0;
  private clockReset = false;
  private graphRebuilt = false;
  private processorTicks = 0;
  private inputFrames = 0;
  private processorErrorName: string | undefined;

  /** Allocate/resume the audio context before an async permission/config wait. */
  prepareAudio() {
    if (this.context || this.cancelled) return;
    const globals = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const AudioCtor = globals.AudioContext ?? globals.webkitAudioContext;
    if (!AudioCtor) throw new Error("Audio capture is not supported");
    this.context = new AudioCtor();
    void this.context.resume().catch(() => {});
  }
  getAudioContext(): AudioContext | undefined { return this.context; }
  diagnostics() { return { ...this.session?.diagnostics(), pcmBytes: this.bytes, queuedBytes: this.queued, connected: this.connected, audioState: this.context?.state, audioTime: this.context?.currentTime, clockReset: this.clockReset, graphRebuilt: this.graphRebuilt, processorTicks: this.processorTicks, inputFrames: this.inputFrames, processorFailed: this.processorFailed, processorErrorName: this.processorErrorName }; }

  connect(onPartial: (text: string, spans?: DictationSpan[]) => void): Promise<void> {
    if (this.connection) return this.connection;
    this.connection = this.open(onPartial);
    void this.connection.catch(error => { this.failure ??= error; });
    return this.connection;
  }

  private async open(onPartial: (text: string, spans?: DictationSpan[]) => void) {
    const session = await createLiveSession();
    this.session = session;
    if (this.cancelled) { await session.cancel(); throw new Error("Live dictation canceled"); }
    let partial = "";
    let revising = false;
    let completed = false;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.result = promise;
    this.rejectResult = reject;
    void session.readEvents({ signal: this.events.signal,
      onDelta: text => { if (!this.cancelled && !completed && !revising) { partial += text; onPartial(partial); } },
      onUpdate: (text, spans) => { if (!this.cancelled && !completed) { revising = true; partial = text; onPartial(partial, spans); } },
      onComplete: text => { if (!completed) { completed = true; resolve(text.trim()); } },
      onError: message => { if (!completed) { completed = true; onPartial(""); reject(new Error(message)); } },
    }).then(() => {
      if (!completed && !this.cancelled) reject(new Error("Live transcription connection closed"));
    }, reject);
    void this.result.catch(error => { this.failure ??= error; });
    this.connected = true;
    for (const bytes of this.pcm) this.upload(bytes);
  }

  async start(stream: MediaStream) {
    if (this.cancelled || this.stopping) return;
    this.prepareAudio();
    const context = this.context!;
    await audioStep(context.audioWorklet.addModule("/dictation-pcm-worklet.js"), "Audio worklet loading");
    if (this.cancelled || this.stopping) { this.closeAudio(); return; }
    const node = new AudioWorkletNode(context, "pcm24k-processor");
    node.onprocessorerror = event => {
      this.processorErrorName = event instanceof ErrorEvent && event.error instanceof Error ? event.error.name : "processorerror";
      this.processorFailed = true;
      this.failure ??= new AudioCaptureError("Live audio processor stopped producing audio");
    };
    const source = context.createMediaStreamSource(stream);
    this.node = node;
    this.source = source;
    node.port.onmessage = event => {
      if (event.data.type === "health") { this.processorTicks = event.data.ticks; this.inputFrames = event.data.inputFrames; return; }
      if (event.data.type === "stopped") { this.flushed?.(); return; }
      if (event.data.type !== "pcm" || this.cancelled) return;
      const bytes = new Uint8Array(event.data.buffer as ArrayBuffer);
      this.bytes += bytes.byteLength;
      if (this.bytes > MAX_LIVE_QUEUE_BYTES) {
        this.failure ??= new Error("Live recording reached its size limit");
        return;
      }
      this.pcm.push(bytes);
      if (this.connected && !this.failure) this.upload(bytes);
    };
    source.connect(node);
    node.connect(context.destination);
    await audioStep(context.resume(), "Audio resume");
    this.clockStart = context.currentTime;
    // Safari can report running after foregrounding while its render clock is
    // stopped. Recover that specific state on the same graph, never by changing providers.
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    if (this.cancelled || this.stopping) return;
    if (context.currentTime === this.clockStart) {
      this.clockReset = true;
      await audioStep(context.suspend(), "Audio suspension");
      if (!this.cancelled && !this.stopping) await audioStep(context.resume(), "Audio restart");
      const recoveredAt = context.currentTime;
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      if (!this.cancelled && !this.stopping && context.currentTime === recoveredAt) {
        if (!this.graphRebuilt && this.bytes === 0) {
          this.graphRebuilt = true;
          this.closeAudio();
          this.prepareAudio();
          await this.start(stream);
          return;
        }
        throw new AudioCaptureError("Audio engine did not restart after returning to Nook");
      }
    }
  }

  private upload(bytes: Uint8Array<ArrayBuffer>) {
    const session = this.session;
    if (!session || this.cancelled || this.failure) return;
    this.queued += bytes.byteLength;
    if (this.queued > MAX_LIVE_QUEUE_BYTES) {
      this.failure ??= new Error("Live recording buffer is full");
      void session.cancel();
      return;
    }
    void session.putPcm(bytes).catch(error => { this.failure ??= error; })
      .finally(() => { this.queued -= bytes.byteLength; });
  }

  finish(onAudioStopped?: () => void): Promise<string> {
    if (!this.finishPromise) this.finishPromise = this.finishOnce(onAudioStopped);
    return this.finishPromise;
  }

  private async finishOnce(onAudioStopped?: () => void): Promise<string> {
    if (this.cancelled) throw new Error("Live dictation canceled");
    if (this.processorFailed) throw new AudioCaptureError("Audio processor stopped");
    if (this.node) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timeout: TimerHandle = setTimeout(() => reject(new AudioCaptureError("Microphone flush timed out")), 3000);
      this.flushed = () => { clearTimeout(timeout); this.flushed = undefined; resolve(); };
      this.node.port.postMessage({ type: "stop" });
      await promise;
      this.closeAudio();
    }
    if (this.bytes === 0) throw new AudioCaptureError("Audio processor received no microphone frames");
    onAudioStopped?.();
    await this.connection;
    if (this.failure) throw this.failure;
    const session = this.session;
    const result = this.result;
    if (!session || !result) throw new Error("Live dictation is not connected");
    await session.commit();
    let timer: TimerHandle | undefined;
    try {
      return await Promise.race([result, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Live transcription timed out")), 65_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async replay(pcm: Uint8Array<ArrayBuffer>[]): Promise<string> {
    await this.connection;
    if (this.cancelled || !this.session) throw new Error("Live dictation canceled");
    const total = pcm.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (total === 0 || total > MAX_LIVE_QUEUE_BYTES) throw new AudioCaptureError("No valid live audio was captured; keep the download and start a new recording");
    this.bytes = total;
    for (const chunk of pcm) {
      if (this.cancelled) throw new Error("Live dictation canceled");
      await this.session.putPcm(chunk);
    }
    return this.finish();
  }

  private closeAudio() {
    const node = this.node;
    this.node = undefined;
    this.source?.disconnect();
    this.source = undefined;
    node?.port.close();
    node?.disconnect();
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopping = true;
    this.closeAudio();
    this.events.abort();
    this.rejectResult?.(new Error("Live dictation canceled"));
    this.rejectResult = undefined;
    if (this.session) void this.session.cancel();
  }
}
