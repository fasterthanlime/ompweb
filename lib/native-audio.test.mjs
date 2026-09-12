import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { NativeAudioSource, pcmWave } = await createJiti(import.meta.url).import('./native-audio.ts');

test('stop drains an in-flight read before the final native chunk', async () => {
  let resolveRead;
  const commands = [];
  const chunks = [];
  const handler = { postMessage({ command }) {
    commands.push(command);
    if (command === 'start') return Promise.resolve({ version: 1 });
    if (command === 'read') return new Promise(resolve => { resolveRead = resolve; });
    if (command === 'stop') return Promise.resolve('AwA=');
    return Promise.resolve(true);
  } };
  const source = new NativeAudioSource(handler, bytes => chunks.push([...bytes]), error => { throw error; });
  await source.start();
  const stopped = source.stop();
  resolveRead('AQA=');
  await stopped;
  assert.deepEqual(commands, ['start', 'read', 'stop']);
  assert.deepEqual(chunks, [[1, 0], [3, 0]]);
});

test('cancel while permission is pending releases the late start and never polls', async () => {
  let resolveStart;
  const commands = [];
  const source = new NativeAudioSource({ postMessage(message) {
    commands.push(message);
    if (message.command === 'start') return new Promise(resolve => { resolveStart = resolve; });
    return Promise.resolve(true);
  } }, () => assert.fail('Unexpected PCM'), () => assert.fail('Unexpected failure'));
  const starting = source.start();
  source.cancel();
  resolveStart({ version: 1 });
  await starting;
  assert.deepEqual(commands.map(c => c.command), ['start', 'cancel', 'cancel']);
  assert.equal(new Set(commands.map(c => c.id)).size, 1);
});

test('cancel suppresses late audio and each recording has its own native ID', async () => {
  let resolveRead;
  const messages = [];
  const handler = { postMessage(message) {
    messages.push(message);
    if (message.command === 'start') return Promise.resolve({ version: 1 });
    if (message.command === 'read') return new Promise(resolve => { resolveRead = resolve; });
    return Promise.resolve(true);
  } };
  const first = new NativeAudioSource(handler, () => assert.fail('Late PCM'), () => assert.fail('Late error'));
  await first.start();
  first.cancel();
  resolveRead('AQA=');
  await Promise.resolve();
  const second = new NativeAudioSource(handler, () => {}, () => {});
  await second.start();
  second.cancel();
  resolveRead('');
  const starts = messages.filter(m => m.command === 'start');
  assert.notEqual(starts[0].id, starts[1].id);
});

test('malformed native audio fails and releases recording', async () => {
  const failure = Promise.withResolvers();
  const commands = [];
  const source = new NativeAudioSource({ postMessage({ command }) {
    commands.push(command);
    return Promise.resolve(command === 'start' ? { version: 1 } : command === 'read' ? 'AQ==' : true);
  } }, () => assert.fail('Invalid frame accepted'), failure.resolve);
  await source.start();
  assert.match((await failure.promise).message, /PCM/);
  assert.ok(commands.includes('cancel'));
});

test('retained WAV contains exact original PCM and 24 kHz mono format', async () => {
  const blob = pcmWave([Uint8Array.of(0, 128, 255, 127), Uint8Array.of(0, 0)]);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual([...new Uint8Array(buffer, 44)], [0, 128, 255, 127, 0, 0]);
});
