import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "omp-web-interaction-reminder-"));
const path = join(root, "interaction-reminders.json");
process.env.OMP_WEB_INTERACTION_REMINDERS_PATH = path;
const subject = await createJiti(import.meta.url).import("./interaction-reminder.ts");
const text = await createJiti(import.meta.url).import("./interaction-reminder-text.ts");

const target = (id, reminderAlias) => ({ id, role: "user", preview: "message", ...(reminderAlias ? { reminderAlias } : {}) });

test.after(() => {
  delete process.env.OMP_WEB_INTERACTION_REMINDERS_PATH;
  rmSync(root, { recursive: true, force: true });
});

test("allocates distinct aliases for identical submissions and persists before send", () => {
  const first = subject.prepareInteractionPrompt("session-one", "same message");
  const second = subject.prepareInteractionPrompt("session-one", "same message");
  const firstAlias = text.extractInteractionAlias(first);
  const secondAlias = text.extractInteractionAlias(second);
  assert.match(firstAlias, /^[0-9a-f-]{36}$/);
  assert.match(secondAlias, /^[0-9a-f-]{36}$/);
  assert.notEqual(firstAlias, secondAlias);
  assert.equal(existsSync(path), true);
  assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.aliases[firstAlias].status, "pending");
  assert.equal(persisted.aliases[secondAlias].status, "pending");
});

test("resolves once, reloads canonical mapping, and rejects duplicates or misses", () => {
  const prompt = subject.prepareInteractionPrompt("session-two", "react here");
  const alias = text.extractInteractionAlias(prompt);
  assert.equal(subject.resolveInteractionAlias("session-two", alias, [target("native-1", alias)]), "native-1");
  assert.equal(subject.resolveInteractionAlias("session-two", alias, [target("native-1", alias)]), "native-1");
  assert.throws(() => subject.resolveInteractionAlias("session-two", alias, [target("native-1", alias), target("native-2", alias)]), /ambiguous|changed|available/);

  const missedPrompt = subject.prepareInteractionPrompt("session-two", "missing");
  const missed = text.extractInteractionAlias(missedPrompt);
  assert.throws(() => subject.resolveInteractionAlias("session-two", missed, []), /not found/);
  assert.equal(subject.resolveInteractionAlias("session-two", missed, [target("other", missed)]), "other");
  assert.throws(() => subject.resolveInteractionAlias("session-other", alias, [target("native-1", alias)]), /Unknown/);
  assert.equal(subject.resolveInteractionAlias("session-two", "native-direct", [target("native-direct")]), "native-direct");
  assert.throws(() => subject.resolveInteractionAlias("session-two", "native-unknown", [target("native-known")]), /Unknown/);
});

test("strips only a well-formed generated sidecar and preserves user text", () => {
  const original = "A <system-reminder> authored by the user </system-reminder>\n";
  const prompt = subject.prepareInteractionPrompt("session-three", original, { expression: "<x>&", caption: 'say "hi"' });
  assert.equal(text.stripInteractionReminder(prompt), original);
  assert.equal(text.extractInteractionAlias(prompt) !== undefined, true);
  assert.equal(text.stripInteractionReminder(`${prompt} broken`), `${prompt} broken`);
  const arbitrary = `${original}\n\n<system-reminder><nook-interaction-reminder alias="123"></nook-interaction-reminder></system-reminder>`;
  assert.equal(text.stripInteractionReminder(arbitrary), arbitrary);
  assert.equal(text.extractInteractionAlias(arbitrary), undefined);
});

test("skips slash commands and does not invent expression age", () => {
  assert.equal(subject.prepareInteractionPrompt("session-four", "  /compact"), "  /compact");
  const prompt = subject.prepareInteractionPrompt("session-four", "hello");
  assert.match(prompt, /<expression age="unknown"/);
});
