import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./transcript-reconciliation.ts");
}

const user = (content, timestamp) => ({ role: "user", content, timestamp });
const assistant = (text, timestamp = 2) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "test",
  provider: "test",
  timestamp,
});

test("terminal reload keeps an optimistic slash command missing from a stale snapshot", async () => {
  const { reconcileTerminalMessages, userMessageKey } = await loadSubject();
  const optimistic = user("/session rename fixed", 20);
  const snapshot = [user("Earlier", 1), assistant("Done")];

  assert.deepEqual(
    reconcileTerminalMessages(snapshot, [...snapshot, optimistic], userMessageKey(optimistic)),
    [...snapshot, optimistic],
  );
});

test("terminal reload uses the authoritative copy once the prompt is persisted", async () => {
  const { reconcileTerminalMessages, userMessageKey } = await loadSubject();
  const optimistic = user("/session rename fixed", 20);
  const persisted = user("/session rename fixed", 21);
  const snapshot = [user("Earlier", 1), persisted];

  assert.strictEqual(
    reconcileTerminalMessages(snapshot, [...snapshot, optimistic], userMessageKey(optimistic)),
    snapshot,
  );
});

test("late queued user delivery is appended after terminal completion", async () => {
  const { appendDeliveredUserMessage } = await loadSubject();
  const delivered = user("Queued steer", 30);
  const current = [user("Initial prompt", 1), assistant("Stopped")];

  assert.deepEqual(appendDeliveredUserMessage(current, delivered, null), [...current, delivered]);
});

test("late queued user delivery is idempotent after a disk reload", async () => {
  const { appendDeliveredUserMessage } = await loadSubject();
  const delivered = user("Queued steer", 30);
  const current = [user("Initial prompt", 1), assistant("Stopped"), { ...delivered }];

  assert.strictEqual(appendDeliveredUserMessage(current, delivered, null), current);
});

test("terminal reload cannot erase a late queued user delivery", async () => {
  const { deliveredUserMessageKey, reconcileTerminalMessages } = await loadSubject();
  const delivered = user("Queued steer", 30);
  const snapshot = [user("Initial prompt", 1), assistant("Stopped")];
  const current = [...snapshot, delivered];

  assert.deepEqual(
    reconcileTerminalMessages(snapshot, current, null, new Set([deliveredUserMessageKey(delivered)])),
    current,
  );
});
