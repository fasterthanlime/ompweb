import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "ompweb-session-preferences-"));
const path = join(root, "preferences.json");
process.env.OMP_WEB_SESSION_PREFERENCES = path;
const subject = await import(`./session-preferences.ts?test=${Date.now()}`);

test.after(() => {
  delete process.env.OMP_WEB_SESSION_PREFERENCES;
  rmSync(root, { recursive: true, force: true });
});

test("persists advisor choice per session", () => {
  assert.equal(subject.getSessionAdvisorEnabled("one"), false);
  subject.setSessionAdvisorEnabled("one", true);
  subject.setSessionAdvisorEnabled("two", false);
  assert.equal(subject.getSessionAdvisorEnabled("one"), true);
  assert.equal(subject.getSessionAdvisorEnabled("two"), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).sessions.one.advisorEnabled, true);
});

test("tolerates a corrupt preferences file", () => {
  writeFileSync(path, "{not-json", "utf8");
  assert.equal(subject.getSessionAdvisorEnabled("one"), false);
  subject.setSessionAdvisorEnabled("recovered", true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).sessions.recovered.advisorEnabled, true);
});

test("removes preferences for a deleted session", () => {
  subject.setSessionAdvisorEnabled("deleted", true);
  subject.setSessionAdvisorEnabled("kept", true);
  subject.deleteSessionPreferences("deleted");
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.sessions.deleted, undefined);
  assert.equal(persisted.sessions.kept.advisorEnabled, true);
});
