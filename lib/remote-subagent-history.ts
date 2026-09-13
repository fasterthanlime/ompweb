import { spawn } from "node:child_process";
import { sshRpcArguments } from "./remote-targets";
import { extractSubagentHistoryFromEntries } from "./subagent-history";
import { parseJsonlLenient } from "./omp/session-files";
import { entryToUiMessage } from "./session-reader";
import type { SessionEntry } from "./types";
const reader = String.raw`import os,sys,json,base64,stat
parent,agent,kind,offset=sys.argv[1:]
p=os.path.realpath(parent)
root=os.path.splitext(p)[0]
if kind=='parent': target=p
else:
 if not agent or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in agent): raise ValueError('Invalid agent')
 target=os.path.join(root,agent+('.md' if kind=='completion' else '.jsonl'))
 if os.path.dirname(os.path.realpath(target))!=os.path.realpath(root): raise ValueError('Artifact escaped directory')
try:
 f=open(target,'rb')
except FileNotFoundError:
 print(json.dumps({'missing':True}));sys.exit(0)
with f:
 info=os.fstat(f.fileno())
 if not stat.S_ISREG(info.st_mode): raise ValueError('Not a regular file')
 size=info.st_size
 cap=4194304 if kind=='parent' else 1048576 if kind=='completion' else 262144
 start=max(0,size-cap) if kind=='parent' else int(offset)
 reset=start>size
 if reset: start=0
 f.seek(start);data=f.read(cap)
 if kind=='parent' and start: data=data[data.find(b'\n')+1:]
 if kind=='transcript' and start+len(data)<size:
  end=data.rfind(b'\n')
  if end<0: raise ValueError('Transcript entry exceeds page limit')
  data=data[:end+1]
 print(json.dumps({'data':base64.b64encode(data).decode(),'size':size,'start':start,'next':start+len(data),'reset':reset,'truncated':size>cap}))
`;
async function read(destination: string, parent: string, agent: string, kind: "parent" | "completion" | "transcript", offset = 0) {
  if (!parent.startsWith("/") || !parent.endsWith(".jsonl") || /[\x00-\x1f]/.test(parent)) throw new Error("Invalid remote parent session path");
  if (kind !== "parent" && !/^[A-Za-z0-9_-]{1,80}$/.test(agent)) throw new Error("Invalid subagent id");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid transcript offset");
  return new Promise<{ missing?: boolean; data?: string; size: number; start: number; next: number; reset: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn("ssh", sshRpcArguments(destination, "python3", ["-c", reader, parent, agent, kind, String(offset)]));
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error("Remote history read timed out")), 15000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 6 * 1024 * 1024) fail(new Error("Remote history response exceeded limit")); else chunks.push(chunk); });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", code => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) { reject(new Error("Remote artifact unavailable or outside allowed directory")); return; } try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid remote history response")); } });
  });
}
const cache = new Map<string, { at: number; value: ReturnType<typeof extractSubagentHistoryFromEntries> }>();
export async function remoteSubagentHistory(destination: string, parent: string) {
  const key = `${destination}:${parent}`; const existing = cache.get(key);
  if (existing && Date.now() - existing.at < 10000) return existing.value;
  const result = await read(destination, parent, "", "parent");
  const entries = result.data ? parseJsonlLenient<SessionEntry>(Buffer.from(result.data, "base64").toString("utf8")) : [];
  const value = extractSubagentHistoryFromEntries(entries);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return value;
}
export async function remoteSubagentArtifact(destination: string, parent: string, agent: string, kind: "completion" | "transcript", offset = 0) {
  const result = await read(destination, parent, agent, kind, offset);
  const bytes = Buffer.from(result.data ?? "", "base64");
  const text = new TextDecoder().decode(bytes, { stream: result.truncated && kind === "completion" });
  const sessionFile = parent.replace(/\.jsonl$/, "") + "/" + agent + (kind === "completion" ? ".md" : ".jsonl");
  if (kind === "completion") return { sessionFile, completion: result.missing ? null : text, truncated: result.truncated ?? false };
  return { sessionFile, fromByte: result.start ?? offset, nextByte: result.next ?? offset, reset: result.reset ?? false, totalBytes: result.size ?? 0, messages: parseJsonlLenient<SessionEntry>(text).map(entry => entryToUiMessage(entry, { deferThinking: false })).filter(Boolean) };
}
