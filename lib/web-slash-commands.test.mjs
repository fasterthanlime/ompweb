import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./web-slash-commands.ts");
}


test("lookup resolves by primary name only", async () => {
  const { getWebSlashCommand } = await loadSubject();
  assert.equal(getWebSlashCommand("goal")?.name, "goal");
  assert.equal(getWebSlashCommand("plan")?.name, "plan");
  assert.equal(getWebSlashCommand("vibe"), undefined);
  assert.equal(getWebSlashCommand("GOAL"), undefined);
});


test("expansion expands web commands, rejects missing args, and passes others through", async () => {
  const { expandWebSlashCommand } = await loadSubject();

  const expanded = expandWebSlashCommand("/plan ship the export");
  assert.equal(expanded.kind, "expand");
  if (expanded.kind === "expand") assert.match(expanded.prompt, /ship the export/);

  const usage = expandWebSlashCommand("/plan ");
  assert.equal(usage.kind, "usage-error");
  if (usage.kind === "usage-error") {
    assert.equal(usage.command, "/plan");
    assert.equal(usage.argumentHintKey, "chatInput.cmdPlanArg");
  }

  assert.equal(expandWebSlashCommand("/goal ship it").kind, "not-web");
  assert.equal(expandWebSlashCommand("/goal pause").kind, "not-web");
  // Plain messages and non-web commands are not the client's business.
  assert.equal(expandWebSlashCommand("just a message").kind, "not-web");
  assert.equal(expandWebSlashCommand("/compact").kind, "not-web");
  assert.equal(expandWebSlashCommand("/vibe go fast").kind, "not-web");
});
