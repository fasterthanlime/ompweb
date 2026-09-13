import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function writeFakeOmp(dir) {
  const fakeOmp = join(dir, "fake-omp.mjs");
  writeFileSync(fakeOmp, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const resumeAt = process.argv.indexOf("--resume");
const sessionFile = resumeAt >= 0 ? process.argv[resumeAt + 1] : "";
const header = sessionFile ? JSON.parse(readFileSync(sessionFile, "utf8").split("\\n")[0]) : {};
const sessionId = header.id ?? "unknown";
const logPath = process.env.OMP_WEB_RECOVERY_LOG;
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\\n");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [1] }) + "\\n");
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") log({ sessionId, message: command.message });
    const data = command.type === "get_state"
      ? { sessionId, sessionFile, isStreaming: false, isCompacting: false }
      : command.type === "prompt" ? { agentInvoked: true } : {};
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
  }
});
`, { mode: 0o700 });
  chmodSync(fakeOmp, 0o700);
  return fakeOmp;
}

function writeSession(dir, id) {
  const sessionFile = join(dir, `${id}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir })}\n`);
  return sessionFile;
}

function writeSnapshot(path, sessions) {
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions })}\n`, { mode: 0o600 });
}

test("restart recovery resumes only interrupted ordinary turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-recovery-"));
  const preferencesPath = join(dir, "preferences.json");
  const snapshotPath = join(tmpdir(), `omp-web-recovery-${process.pid}-${Date.now()}.json`);
  const logPath = join(dir, "prompts.jsonl");
  const fakeOmp = writeFakeOmp(dir);
  writeFileSync(logPath, "");
  const previous = {
    preferences: process.env.OMP_WEB_SESSION_PREFERENCES,
    snapshot: process.env.OMP_WEB_ACTIVE_SESSIONS_PATH,
    omp: process.env.OMP_WEB_OMP_BIN,
    log: process.env.OMP_WEB_RECOVERY_LOG,
  };
  process.env.OMP_WEB_SESSION_PREFERENCES = preferencesPath;
  process.env.OMP_WEB_ACTIVE_SESSIONS_PATH = snapshotPath;
  process.env.OMP_WEB_OMP_BIN = fakeOmp;
  process.env.OMP_WEB_RECOVERY_LOG = logPath;

  const jiti = createJiti(import.meta.url);
  const { invalidateOmpCliCache } = await jiti.import("./omp/omp-cli.ts");
  invalidateOmpCliCache();
  const {
    getRpcSession,
    restoreActiveRpcSessions,
  } = await jiti.import("./rpc-manager.ts");
  const {
    getSessionGoal,
    setSessionGoal,
  } = await jiti.import("./session-preferences.ts");

  const cases = [
    {
      id: "paused-ordinary",
      turnActive: true,
      goal: { id: "goal-paused", objective: "Paused work", startedAt: 1, status: "paused", pauseReason: "user" },
    },
    {
      id: "completed-ordinary",
      turnActive: true,
      goal: { id: "goal-completed", objective: "Completed work", startedAt: 1, status: "completed", summary: "Done" },
    },
    {
      id: "blocked-ordinary",
      turnActive: true,
      goal: { id: "goal-blocked", objective: "Blocked work", startedAt: 1, status: "blocked", summary: "Needs input" },
    },
    {
      id: "active-autonomous",
      turnActive: true,
      goal: { id: "goal-active", objective: "Autonomous work", startedAt: 1, status: "active" },
    },
    {
      id: "stopped-idle",
      turnActive: false,
      goal: { id: "goal-stopped", objective: "Stopped work", startedAt: 1, status: "paused", pauseReason: "user" },
    },
  ];
  const sessions = cases.map(({ id, turnActive }) => ({
    sessionId: id,
    sessionFile: writeSession(dir, id),
    cwd: dir,
    advisor: false,
    turnActive,
  }));
  for (const { id, goal } of cases) setSessionGoal(id, goal);
  writeSnapshot(snapshotPath, sessions);

  try {
    assert.equal(await restoreActiveRpcSessions(), cases.length);
    await tick();
    const prompts = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(prompts.map(({ sessionId }) => sessionId).sort(), ["blocked-ordinary", "completed-ordinary", "paused-ordinary"]);
    assert.equal(prompts.length, 3, "each eligible interrupted turn recovers exactly once");
    assert.equal(getSessionGoal("paused-ordinary").status, "paused", "paused goal remains paused");
    assert.equal(getSessionGoal("completed-ordinary").status, "completed", "terminal goal metadata remains intact");
    assert.equal(getSessionGoal("active-autonomous").status, "paused", "autonomous goal is pause-protected on restart");
    assert.equal(getSessionGoal("active-autonomous").pauseReason, "interrupted");
    assert.equal(getSessionGoal("stopped-idle").pauseReason, "user");

    assert.equal(await restoreActiveRpcSessions(), 0, "consumed snapshot cannot recover a turn twice");
  } finally {
    await Promise.all(cases.map(({ id }) => getRpcSession(id)?.destroyAndWait()));
    if (previous.preferences === undefined) delete process.env.OMP_WEB_SESSION_PREFERENCES;
    else process.env.OMP_WEB_SESSION_PREFERENCES = previous.preferences;
    if (previous.snapshot === undefined) delete process.env.OMP_WEB_ACTIVE_SESSIONS_PATH;
    else process.env.OMP_WEB_ACTIVE_SESSIONS_PATH = previous.snapshot;
    if (previous.omp === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous.omp;
    if (previous.log === undefined) delete process.env.OMP_WEB_RECOVERY_LOG;
    else process.env.OMP_WEB_RECOVERY_LOG = previous.log;
    // Keep the imported module's exit hook from trying to write below the
    // removed fixture directory when the test process exits.
    writeFileSync(snapshotPath, "");
  }
});
