/**
 * PCM24KProcessor — resamples the mic input live to mono PCM16 at 24 kHz for
 * the local live-dictation endpoint (/api/dictation/live).
 *
 * The main thread never sees raw Float32 audio: this processor quantizes to
 * Int16 LE bytes and posts them as transferable ArrayBuffers, one message per
 * ~85 ms of audio (~8 KiB). The main thread keeps the chunks and uploads them
 * serially; it also forwards `{ type: "stop" }` when the capture ends so the
 * resampler tail is flushed before the final commit.
 *
 * Contract:
 *   - main -> processor: { type: "stop" } — flush remaining PCM, post it, and
 *     close the port. The port is the only message channel; nothing is ever
 *     received after close.
 *   - processor -> main: { type: "pcm", buffer: ArrayBuffer } — Int16 LE,
 *     mono, 24000 Hz, transferred (never copied).
 *
 * Resampling: linear interpolation from the context's input rate to 24 kHz.
 * State across process() calls is a single fractional input position, so a
 * render-quantum boundary never drops or duplicates a sample. At the last
 * sample of a frame the interpolation holds (x1 = x0); this is exact for the
 * common 48 kHz -> 24 kHz decimation (integer positions) and a bounded,
 * inaudible approximation for odd rates like 44.1 kHz. A 24 kHz or higher
 * input is assumed (the endpoint contract is 24 kHz PCM).
 */
class PCM24KProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._pos = 0; // fractional input position of the next output sample, relative to the current frame start
    this._ratio = sampleRate / 24000;
    this._pending = []; // accumulated Int16 samples awaiting a message
    this._stopping = false;
    this._ticks = 0;
    this._inputFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") {
        this._stopping = true;
        this._flush();
        this.port.postMessage({ type: "stopped" });
        this.port.close();
      }
    };
  }

  _flush() {
    if (this._pending.length === 0) return;
    const buffer = new ArrayBuffer(this._pending.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this._pending.length; i++) {
      view.setInt16(i * 2, this._pending[i], true);
    }
    this._pending = [];
    this.port.postMessage({ type: "pcm", buffer }, [buffer]);
  }

  process(inputs) {
    if (this._stopping) return false;
    const input = inputs[0] && inputs[0][0];
    this._ticks++;
    if (input && input.length) this._inputFrames += input.length;
    if (this._ticks === 1 || this._ticks % 128 === 0) {
      this.port.postMessage({ type: "health", ticks: this._ticks, inputFrames: this._inputFrames });
    }
    if (input && input.length > 0) {
      const n = input.length;
      const output = [];
      let pos = this._pos; // carried from the previous frame; 0 <= pos < n
      while (pos < n) {
        const index = Math.floor(pos);
        const weight = pos - index;
        const x0 = input[index];
        const x1 = index + 1 < n ? input[index + 1] : x0; // hold at frame edge
        const value = Math.max(-1, Math.min(1, x0 + (x1 - x0) * weight));
        output.push(Math.round(value * 32767));
        pos += this._ratio;
      }
      this._pos = pos - n; // carry: 0 <= pos - n < this._ratio, so next frame continues seamlessly
      if (output.length > 0) {
        this._pending.push(...output);
        if (this._pending.length >= 4096) this._flush();
      }
    }
    return !this._stopping;
  }
}

registerProcessor("pcm24k-processor", PCM24KProcessor);