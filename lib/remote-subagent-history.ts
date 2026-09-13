import { spawn } from "node:child_process";
import { sshRpcArguments } from "./remote-targets";
import { extractSubagentHistoryFromEntries } from "./subagent-history";
import { parseJsonlLenient } from "./omp/session-files";
import { entryToUiMessage } from "./session-reader";
import type { SessionEntry } from "./types";
import type { SubagentHistoryEntry } from "./subagent-types";

const REMOTE_RESPONSE_MAX_BYTES = 6 * 1024 * 1024;
const REMOTE_READER_TIMEOUT_MS = 15_000;
const REMOTE_AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REMOTE_HISTORY_CACHE_TTL_MS = 10_000;
const REMOTE_HISTORY_CACHE_MAX_ENTRIES = 32;

/**
 * Python 3 is the only remote prerequisite. The helper uses its standard
 * library to open artifacts read-only, enforce realpath confinement, and emit
 * one bounded base64 response; it never starts a remote shell conversation.
 */
const reader = String.raw`import base64
import json
import os
import stat
import sys
PARENT_ROSTER_WINDOW_BYTES = 4 * 1024 * 1024
COMPLETION_WINDOW_BYTES = 1024 * 1024
TRANSCRIPT_PAGE_BYTES = 256 * 1024

parent, agent, kind, offset = sys.argv[1:]
parent_path = os.path.realpath(parent)
artifact_root = os.path.splitext(parent_path)[0]

if kind == "parent":
    target = parent_path
else:
    if (
        not agent
        or len(agent) > 80
        or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in agent)
    ):
        raise ValueError("Invalid agent")
    suffix = ".md" if kind == "completion" else ".jsonl"
    target = os.path.join(artifact_root, agent + suffix)
    if os.path.dirname(os.path.realpath(target)) != os.path.realpath(artifact_root):
        raise ValueError("Artifact escaped directory")

try:
    file = open(target, "rb")
except FileNotFoundError:
    print(json.dumps({"missing": True}))
    sys.exit(0)

with file:
    info = os.fstat(file.fileno())
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Not a regular file")

    size = info.st_size
    if kind == "parent":
        cap = PARENT_ROSTER_WINDOW_BYTES
        start = max(0, size - cap)
    elif kind == "completion":
        cap = COMPLETION_WINDOW_BYTES
        start = int(offset)
    else:
        cap = TRANSCRIPT_PAGE_BYTES
        start = int(offset)

    reset = start > size
    if reset:
        start = 0

    file.seek(start)
    data = file.read(cap)

    # The roster window may begin in the middle of an old JSONL line. Drop
    # that partial line rather than handing malformed bytes to the parser.
    if kind == "parent" and start:
        first_newline = data.find(b"\n")
        data = data[first_newline + 1:] if first_newline >= 0 else b""

    # Transcript offsets are byte offsets and every returned record is whole.
    # A single record larger than the page is rejected instead of looping.
    if kind == "transcript" and start + len(data) < size:
        last_newline = data.rfind(b"\n")
        if last_newline < 0:
            raise ValueError("Transcript entry exceeds page limit")
        data = data[:last_newline + 1]

    print(json.dumps({
        "data": base64.b64encode(data).decode("ascii"),
        "size": size,
        "start": start,
        "next": start + len(data),
        "reset": reset,
        "truncated": size > cap,
    }))
`;
interface RemoteReadResult {
  missing?: boolean;
  data?: string;
  size?: number;
  start?: number;
  next?: number;
  reset?: boolean;
  truncated?: boolean;
}

async function read(
  destination: string,
  parent: string,
  agent: string,
  kind: "parent" | "completion" | "transcript",
  offset = 0,
): Promise<RemoteReadResult> {
  if (!parent.startsWith("/") || !parent.endsWith(".jsonl") || /[\x00-\x1f]/.test(parent)) {
    throw new Error("Invalid remote parent session path");
  }
  if (kind !== "parent" && !REMOTE_AGENT_ID.test(agent)) {
    throw new Error("Invalid subagent id");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid transcript offset");
  }

  return new Promise<RemoteReadResult>((resolve, reject) => {
    // The remote host must provide `python3`; sshRpcArguments keeps the
    // command independently quoted while retaining the shared SSH master.
    const child = spawn("ssh", sshRpcArguments(destination, "python3", ["-c", reader, parent, agent, kind, String(offset)]));
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Remote history read timed out")), REMOTE_READER_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > REMOTE_RESPONSE_MAX_BYTES) {
        fail(new Error("Remote history response exceeded limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Remote artifact unavailable or outside allowed directory"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RemoteReadResult);
      } catch {
        reject(new Error("Invalid remote history response"));
      }
    });
  });
}

const cache = new Map<string, { at: number; value: SubagentHistoryEntry[] }>();

export async function remoteSubagentHistory(destination: string, parent: string) {
  const key = `${destination}:${parent}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < REMOTE_HISTORY_CACHE_TTL_MS) return existing.value;

  const result = await read(destination, parent, "", "parent");
  const entries = result.data
    ? parseJsonlLenient<SessionEntry>(Buffer.from(result.data, "base64").toString("utf8"))
    : [];
  const value = extractSubagentHistoryFromEntries(entries);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > REMOTE_HISTORY_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

export async function remoteSubagentArtifact(
  destination: string,
  parent: string,
  agent: string,
  kind: "completion" | "transcript",
  offset = 0,
) {
  const result = await read(destination, parent, agent, kind, offset);
  const bytes = Buffer.from(result.data ?? "", "base64");
  const text = new TextDecoder().decode(bytes, { stream: result.truncated && kind === "completion" });
  const sessionFile = parent.replace(/\.jsonl$/, "") + "/" + agent + (kind === "completion" ? ".md" : ".jsonl");

  if (kind === "completion") {
    return { sessionFile, completion: result.missing ? null : text, truncated: result.truncated ?? false };
  }
  return {
    sessionFile,
    fromByte: result.start ?? offset,
    nextByte: result.next ?? offset,
    reset: result.reset ?? false,
    totalBytes: result.size ?? 0,
    messages: parseJsonlLenient<SessionEntry>(text)
      .map((entry) => entryToUiMessage(entry, { deferThinking: false }))
      .filter(Boolean),
  };
}
