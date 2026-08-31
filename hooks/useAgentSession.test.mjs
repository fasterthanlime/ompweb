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
  assert.match(source, /eventSourceRef\.current === es/);
  assert.match(source, /managedSessionRunningRef\.current && sessionIdRef\.current === sid/);
});

test("externally started turns attach the stream and enter the running state", () => {
  const externalBlock = source.slice(
    source.indexOf("subscribeRunningSessionIds(("),
    source.indexOf("}, [connectEvents, loadSession])"),
  );
  assert.match(externalBlock, /if \(eventSourceRef\.current \|\| agentRunningRef\.current\) return;/);
  assert.match(externalBlock, /managedSessionRunningRef\.current = true/);
  assert.match(externalBlock, /void connectEvents\(sid\)/);
  assert.match(externalBlock, /reconnectActionsRef\.current\?\.\(sid\)/);
  assert.match(externalBlock, /setAgentRunning\(true\)/);
  assert.match(externalBlock, /void loadSession\(sid\)/);
});

test("hot sends reuse the open event stream and skip get_state", () => {
  assert.match(source, /eventSourceSessionIdRef\.current === session\.id/);
  assert.match(source, /eventSourceRef\.current\?\.readyState === EventSource\.OPEN/);
  assert.match(source, /if \(!streamIsLive\) \{\s*\/\/ Cold path:[\s\S]*?type: "get_state"/);
  assert.match(source, /if \(existing && eventSourceSessionIdRef\.current === sid\)/);
  assert.match(source, /existing\.readyState === EventSource\.OPEN/);
});
