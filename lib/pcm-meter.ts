/** RMS per time slice, mapped from quiet speech (-60 dBFS) to loud (-12 dBFS). */
export function pcmMeterLevels(bytes: Uint8Array<ArrayBuffer>, bars: number): number[] {
  const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  return Array.from({ length: bars }, (_, i) => {
    const start = Math.floor(i * count / bars);
    const end = Math.min(count, Math.max(start + 1, Math.floor((i + 1) * count / bars)));
    let energy = 0;
    for (let sample = start; sample < end; sample++) {
      const amplitude = samples.getInt16(sample * 2, true) / 32768;
      energy += amplitude * amplitude;
    }
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    const db = 20 * Math.log10(Math.max(rms, 0.000001));
    return Math.max(6, Math.min(100, (db + 60) / 48 * 100));
  });
}
