type NativeAudioHandler = { postMessage(message: { command: string; id: string }): Promise<unknown> };

export function nativeAudioHandler(): NativeAudioHandler | undefined {
  if (typeof window === "undefined") return;
  return (window as Window & { webkit?: { messageHandlers?: { nookAudioV1?: NativeAudioHandler } } })
    .webkit?.messageHandlers?.nookAudioV1;
}

/** One capture owns its native ID; late replies cannot affect a successor. */
export class NativeAudioSource {
  private readonly id = crypto.randomUUID();
  private stopped = false;
  private cancelled = false;
  private lastPcmAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: Promise<void>;
  private failure?: Error;

  constructor(private readonly handler: NativeAudioHandler,
    private readonly onPcm: (bytes: Uint8Array<ArrayBuffer>) => void,
    private readonly onError: (error: Error) => void) {}

  async start() {
    const response = await this.handler.postMessage({ command: "start", id: this.id });
    if (this.stopped) { await this.handler.postMessage({ command: "cancel", id: this.id }); return; }
    if (!response || typeof response !== "object" || !("version" in response) || response.version !== 1) {
      throw new Error("Unsupported Nook microphone bridge");
    }
    this.lastPcmAt = performance.now();
    this.poll();
  }

  private accept(value: unknown) {
    if (typeof value !== "string" || value.length > 128_000) throw new Error("Invalid native microphone frame");
    const decoded = atob(value);
    if (decoded.length % 2) throw new Error("Invalid native PCM sample");
    if (decoded.length) {
      this.lastPcmAt = performance.now();
      this.onPcm(Uint8Array.from(decoded, character => character.charCodeAt(0)));
    } else if (performance.now() - this.lastPcmAt > 3000) {
      throw new Error("Native microphone stopped producing audio");
    }
  }

  private poll() {
    if (this.stopped) return;
    this.reading = this.handler.postMessage({ command: "read", id: this.id }).then(value => {
      if (!this.stopped) this.accept(value);
    }).catch(cause => {
      this.failure = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.stopped) { this.onError(this.failure); this.cancel(); }
    });
    void this.reading.then(() => {
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), 100);
    });
  }

  async stop() {
    clearTimeout(this.timer);
    // Drain the outstanding read before requesting the final native frames.
    await this.reading;
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.cancelled) throw new Error("Native recording canceled");
    if (this.failure) throw this.failure;
    const final = await this.handler.postMessage({ command: "stop", id: this.id });
    if (!this.cancelled) this.accept(final);
  }

  cancel() {
    this.cancelled = true;
    this.stopped = true;
    clearTimeout(this.timer);
    void this.handler.postMessage({ command: "cancel", id: this.id }).catch(() => {});
  }
}

export function pcmWave(chunks: Uint8Array<ArrayBuffer>[]): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, 36 + length, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, length, true);
  return new Blob([header, ...chunks], { type: "audio/wav" });
}
