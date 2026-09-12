import assert from "node:assert/strict";
import test from "node:test";
import { raceWithDeadline, DictationTimeoutError, DictationAbortedError, translateDictationError, DictationRateLimitError } from "./google-dictation.ts";

test("deadline releases a hung upload and cleans its eventual result", async () => {
  const deadline = new AbortController();
  let finish;
  const late = [];
  const upload = new Promise(resolve => { finish = resolve; });
  const result = raceWithDeadline(upload, undefined, deadline.signal, value => late.push(value));
  deadline.abort();
  await assert.rejects(result, DictationTimeoutError);
  finish({ name: "files/late" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(late, [{ name: "files/late" }]);
});

test("already aborted callers cannot wait for provider work", async () => {
  const result = raceWithDeadline(new Promise(() => {}), AbortSignal.abort(), new AbortController().signal);
  await assert.rejects(result, DictationAbortedError);
});

test("late provider rejection is consumed after cancellation", async () => {
  const cancel = new AbortController();
  let fail;
  const result = raceWithDeadline(new Promise((_, reject) => { fail = reject; }), cancel.signal, new AbortController().signal);
  cancel.abort();
  await assert.rejects(result, DictationAbortedError);
  fail(new Error("late provider failure"));
  await new Promise(resolve => setImmediate(resolve));
});

test("bridge and upload HTTP 429 errors retain rate-limit classification", () => {
  const signal = new AbortController().signal;
  assert.ok(translateDictationError({ status: 429 }, undefined, signal) instanceof DictationRateLimitError);
});
