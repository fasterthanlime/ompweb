import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("managed sessions attach SSE while idle for external turns", () => {
  const managedBlock = source.slice(
    source.indexOf("if (agentState?.running)"),
    source.indexOf("if (agentState?.state)", source.indexOf("if (agentState?.running)")),
  );
  assert.match(managedBlock, /void connectEvents\(session\.id\)/);
  assert.ok(
    managedBlock.indexOf("void connectEvents(session.id)") <
      managedBlock.indexOf("if (agentState.state?.isStreaming || agentState.state?.isPromptRunning)"),
    "SSE attachment must not be gated by the current busy state",
  );
});

test("idle managed streams reconnect after fatal SSE closure", () => {
  assert.match(source, /eventSourceRef\.current === es && managedSessionRunningRef\.current/);
  assert.match(source, /managedSessionRunningRef\.current && sessionIdRef\.current === sid/);
});
