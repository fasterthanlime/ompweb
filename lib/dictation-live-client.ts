import { readDictationDisplayMode, parseDictationSpans, type DictationSpan } from "./dictation-display";
export const MAX_LIVE_QUEUE_BYTES = 5 * 60 * 24000 * 2;
const MAX_FRAME = 2 * 24000 * 2;

type LiveEvent = { type: 'delta' | 'updated' | 'completed' | 'error'; text?: string; error?: string; spans?: DictationSpan[]; itemId?: string };

export async function detectLiveDictation(): Promise<boolean> {
  const response = await fetch('/api/dictation/live', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Unable to check dictation configuration');
  const result = await response.json();
  return result.enabled === true;
}

export interface LiveDictationReadOptions {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onUpdate?: (text: string, spans?: DictationSpan[]) => void;
  onComplete: (text: string) => void;
  onError: (error: string) => void;
}

export class LiveDictationSession {
  private readonly socket: WebSocket;
  private failure: Error | null = null;
  private chain: Promise<void> = Promise.resolve();
  private committed = false;
  private terminal = false;
  private cancelled = false;
  private events: LiveEvent[] = [];
  private listener?: (event: LiveEvent) => void;
  private cancelPromise?: Promise<void>;
  readonly ready: Promise<void>;
  private closeCode: number | undefined;
  diagnostics() { return { socketState: this.socket.readyState, bufferedBytes: this.socket.bufferedAmount, closeCode: this.closeCode }; }

  constructor() {
    const url = new URL('/api/dictation/live/socket', location.href);
    url.searchParams.set('displayMode', readDictationDisplayMode());
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ready = promise;
    let settled = false;
    const timer = setTimeout(() => {
      this.fail(new Error('Live dictation connection timed out'));
      failReady(this.failure ?? new Error('Live dictation connection timed out'));
    }, 15_000);
    const finishReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const failReady = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    this.socket.onmessage = message => {
      if (this.cancelled) return;
      let event: LiveEvent | { type: 'ready' };
      try { event = JSON.parse(message.data) as LiveEvent | { type: 'ready' }; }
      catch { this.fail(new Error('Invalid dictation response')); return; }
      if (event.type === 'ready') { finishReady(); return; }
      if (event.type === 'error') { this.fail(new Error(event.error || 'Live transcription failed')); return; }
      if (event.type !== 'delta' && event.type !== 'updated' && event.type !== 'completed') return;
      if (typeof event.text !== 'string') { this.fail(new Error('Invalid dictation transcript')); return; }
      if (event.type === 'updated') event.spans = parseDictationSpans(event.spans, event.text);
      if (event.type === 'completed') this.terminal = true;
      this.deliver(event);
    };
    const failed = () => {
      if (!this.terminal && !this.cancelled) this.fail(new Error('Live transcription connection closed'));
      failReady(this.failure ?? new Error('Live dictation canceled'));
    };
    this.socket.onerror = failed;
    this.socket.onclose = event => { this.closeCode = event.code; failed(); };
    void this.ready.catch(() => {});
  }

  private deliver(event: LiveEvent) {
    if (this.cancelled || this.terminal && event.type !== 'completed') return;
    if (this.listener) this.listener(event);
    else this.events.push(event);
  }

  private fail(error: Error) {
    if (this.failure || this.terminal || this.cancelled) return;
    this.failure = error;
    this.deliver({ type: 'error', error: error.message });
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  private enqueue(operation: () => Promise<void>) {
    if (this.cancelled) return Promise.reject(new Error('Live dictation canceled'));
    const result = this.chain.then(() => {
      if (this.cancelled) throw new Error('Live dictation canceled');
      return operation();
    });
    this.chain = result;
    void result.catch(error => this.fail(error instanceof Error ? error : new Error('Live upload failed')));
    return result;
  }

  private async drain() {
    const deadline = Date.now() + 10_000;
    while (this.socket.bufferedAmount > 128 * 1024) {
      if (this.failure) throw this.failure;
      if (this.cancelled) throw new Error('Live dictation canceled');
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Live dictation connection closed');
      if (Date.now() >= deadline) throw new Error('Live audio connection stalled');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (this.failure) throw this.failure;
    if (this.cancelled) throw new Error('Live dictation canceled');
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Live dictation connection closed');
  }

  putPcm(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.committed) return Promise.reject(new Error('Live dictation already committed'));
    return this.enqueue(async () => {
      await this.ready;
      for (let offset = 0; offset < data.length; offset += MAX_FRAME) {
        await this.drain();
        this.socket.send(data.subarray(offset, offset + MAX_FRAME));
      }
    });
  }

  commit(): Promise<void> {
    if (this.committed) return Promise.reject(new Error('Live dictation already committed'));
    if (this.cancelled) return Promise.reject(new Error('Live dictation canceled'));
    this.committed = true;
    return this.enqueue(async () => {
      await this.ready;
      await this.drain();
      this.socket.send(JSON.stringify({ type: 'commit' }));
    });
  }

  readEvents(options: LiveDictationReadOptions): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        if (this.listener === listener) this.listener = undefined;
        options.signal.removeEventListener('abort', finish);
        resolve();
      };
      const listener = (event: LiveEvent) => {
        if (event.type === 'delta') options.onDelta(event.text!);
        else if (event.type === 'updated') options.onUpdate?.(event.text!, event.spans);
        else {
          if (event.type === 'completed') options.onComplete(event.text!);
          else options.onError(event.error!);
          finish();
        }
      };
      this.listener = listener;
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted || this.cancelled) { finish(); return; }
      for (const event of this.events.splice(0)) listener(event);
    });
  }

  async cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelled = true;
    this.failure ??= new Error('Live dictation canceled');
    this.listener = undefined;
    this.events = [];
    this.cancelPromise = (async () => {
      if (this.socket.readyState === WebSocket.OPEN && !this.terminal) {
        try { this.socket.send(JSON.stringify({ type: 'cancel' })); } catch { /* already closing */ }
      }
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
    })();
    return this.cancelPromise;
  }
}

export async function createLiveSession(): Promise<LiveDictationSession> {
  const session = new LiveDictationSession();
  await session.ready;
  return session;
}
