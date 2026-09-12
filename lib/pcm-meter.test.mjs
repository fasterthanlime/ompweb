import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { pcmMeterLevels } = await createJiti(import.meta.url).import('./pcm-meter.ts');

test('quiet speech remains visible even when each slice begins at a zero crossing', () => {
  const samples = new Int16Array(3600);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(32768 * 0.01 * Math.sin(2 * Math.PI * i / 100));
  const levels = pcmMeterLevels(new Uint8Array(samples.buffer), 36);
  assert.ok(levels.every(level => level > 30 && level < 40));
  assert.deepEqual(pcmMeterLevels(new Uint8Array(7200), 36), Array(36).fill(6));
});
