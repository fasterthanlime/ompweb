import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { remoteSubagentArtifact, remoteSubagentHistory } = await jiti.import("./remote-subagent-history.ts");

const DESTINATION = "fixture";
const ROSTER_WINDOW_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_PAGE_BYTES = 256 * 1024;

async function withRemoteFixture(t, callback) {
  const root = await mkdtemp(join(tmpdir(), "ompweb-remote-history-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const ssh = join(bin, "ssh");
  // sshRpcArguments deliberately supplies one shell command as its final
  // argument. This shim executes that command locally, so tests exercise the
  // real Python reader without requiring an SSH daemon or remote account.
  await writeFile(
    ssh,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const destinationIndex = args.indexOf(${JSON.stringify(DESTINATION)});
if (destinationIndex < 0) process.exit(2);
const commandArgument = args.at(-1) ?? "";
const child = spawn("/bin/sh", ["-lc", "sh -lc " + commandArgument], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
    { mode: 0o700 },
  );
  await chmod(ssh, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    return await callback(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

function parentEntry(id, status = "completed") {
  return JSON.stringify({
    type: "message",
    id: `parent-${id}`,
    parentId: null,
    timestamp: "2026-09-13T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName: "task",
      content: [],
      details: {
        progress: [{ id, index: 0, agent: "scout", status, task: "Read the fixture" }],
        results: status === "completed" ? [{ id, index: 0, agent: "scout", exitCode: 0, task: "Read the fixture" }] : [],
      },
    },
  });
}

function messageLine(id, role, content) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-13T00:00:00.000Z",
    message: { role, content },
  }) + "\n";
}

async function makeSession(root, parentText = "") {
  const parent = join(root, "session.jsonl");
  const artifacts = join(root, "session");
  await mkdir(artifacts);
  await writeFile(parent, parentText, "utf8");
  return { parent, artifacts };
}

test("recovers a bounded roster from the latest parent window", async (t) => {
  await withRemoteFixture(t, async (root) => {
    // The old line is beyond the bounded window. A valid newline after the
    // window-start partial line lets the current record be recovered exactly.
    const oldRecord = parentEntry("OldAgent");
    const filler = "x".repeat(ROSTER_WINDOW_BYTES + 128);
    const currentRecord = parentEntry("CurrentAgent");
    const { parent } = await makeSession(root, `${oldRecord}\n${filler}\n${currentRecord}\n`);

    const roster = await remoteSubagentHistory(DESTINATION, parent);
    assert.deepEqual(roster.map((entry) => entry.id), ["CurrentAgent"]);
    assert.equal(roster[0].status, "completed");
  });
});

test("returns missing completion and transcript artifacts in their existing shapes", async (t) => {
  await withRemoteFixture(t, async (root) => {
    const { parent } = await makeSession(root);
    const completion = await remoteSubagentArtifact(DESTINATION, parent, "Missing", "completion");
    assert.deepEqual(completion, {
      sessionFile: join(root, "session", "Missing.md"),
      completion: null,
      truncated: false,
    });

    const transcript = await remoteSubagentArtifact(DESTINATION, parent, "Missing", "transcript", 37);
    assert.equal(transcript.sessionFile, join(root, "session", "Missing.jsonl"));
    assert.equal(transcript.messages.length, 0);
    assert.equal(transcript.fromByte, 37);
    assert.equal(transcript.nextByte, 37);
    assert.equal(transcript.totalBytes, 0);
    assert.equal(transcript.reset, false);
  });
});

test("pages UTF-8 transcript bytes at complete-line boundaries and advances offsets", async (t) => {
  await withRemoteFixture(t, async (root) => {
    const { parent, artifacts } = await makeSession(root);
    const transcript = join(artifacts, "Agent.jsonl");
    const first = messageLine("one", "user", `日本語 ${"a".repeat(160_000)}`);
    const second = messageLine("two", "assistant", `second ${"b".repeat(160_000)}`);
    const third = messageLine("three", "user", "tail");
    await writeFile(transcript, first + second + third, "utf8");

    const page1 = await remoteSubagentArtifact(DESTINATION, parent, "Agent", "transcript", 0);
    assert.deepEqual(page1.messages.map((message) => message.role), ["user"]);
    assert.equal(page1.fromByte, 0);
    assert.equal(page1.nextByte, Buffer.byteLength(first, "utf8"));
    assert.equal(page1.totalBytes, Buffer.byteLength(first + second + third, "utf8"));

    const page2 = await remoteSubagentArtifact(DESTINATION, parent, "Agent", "transcript", page1.nextByte);
    assert.deepEqual(page2.messages.map((message) => message.role), ["assistant", "user"]);
    assert.equal(page2.fromByte, page1.nextByte);
    assert.equal(page2.nextByte, page1.nextByte + Buffer.byteLength(second + third, "utf8"));
  });
});

test("rejects a transcript record larger than one page instead of looping", async (t) => {
  await withRemoteFixture(t, async (root) => {
    const { parent, artifacts } = await makeSession(root);
    const oversized = messageLine("large", "assistant", "z".repeat(TRANSCRIPT_PAGE_BYTES + 1));
    await writeFile(join(artifacts, "Large.jsonl"), oversized, "utf8");

    await assert.rejects(
      remoteSubagentArtifact(DESTINATION, parent, "Large", "transcript", 0),
      /Remote artifact unavailable or outside allowed directory/,
    );
  });
});

test("rejects artifact symlinks that resolve outside the sibling directory", async (t) => {
  await withRemoteFixture(t, async (root) => {
    const { parent, artifacts } = await makeSession(root);
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, messageLine("outside", "assistant", "secret"), "utf8");
    try {
      await symlink(outside, join(artifacts, "Escaped.jsonl"));
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }

    await assert.rejects(
      remoteSubagentArtifact(DESTINATION, parent, "Escaped", "transcript", 0),
      /Remote artifact unavailable or outside allowed directory/,
    );
  });
});
