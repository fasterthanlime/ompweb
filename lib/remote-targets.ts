import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RemoteTarget { id: string; name: string; destination: string; cwd: string; ompBin: string; platform?: "darwin" | "linux" | "windows" }

/** Destinations are administrator configured, never supplied as command arguments by chat clients. */
export function getRemoteTargets(): RemoteTarget[] {
  const raw = process.env.OMP_WEB_SSH_TARGETS;
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('OMP_WEB_SSH_TARGETS must be an array');
  const ids = new Set<string>();
  return parsed.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid SSH target');
    const {id,name,destination,cwd,ompBin='omp',platform} = value;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('SSH target id must be unique');
    if (typeof destination !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(destination)) throw new Error('Invalid SSH destination');
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\x00-\x1f]/.test(cwd)) throw new Error('SSH cwd must be an absolute POSIX path');
    if (typeof ompBin !== 'string' || !ompBin || /[\x00-\x1f]/.test(ompBin)) throw new Error('Invalid remote omp executable');
    if (name !== undefined && typeof name !== 'string') throw new Error('Invalid SSH target name');
    if (platform !== undefined && !["darwin", "linux", "windows"].includes(platform)) throw new Error('Invalid remote platform');
    ids.add(id);
    return {id,name:name || id,destination,cwd,ompBin,platform};
  });
}

/**
 * Server-owned OpenSSH control sockets live in a short, owner-private
 * directory. The directory is shared by this web-server account so separate
 * RPC channels to the same destination can reuse one master.
 */
const SSH_CONTROL_ROOT = join(
  tmpdir(),
  `omp-web-ssh-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
);

function ensureSshControlRoot(): string {
  mkdirSync(SSH_CONTROL_ROOT, { recursive: true, mode: 0o700 });
  const stat = lstatSync(SSH_CONTROL_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("SSH control socket directory is not a private directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("SSH control socket directory has the wrong owner");
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(SSH_CONTROL_ROOT, 0o700);
  return SSH_CONTROL_ROOT;
}

/** Deterministic destination identity used as the shared ControlPath. */
export function sshControlPath(destination: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(destination)) throw new Error('Invalid SSH destination');
  const key = createHash("sha256").update(destination, "utf8").digest("hex").slice(0, 32);
  return join(ensureSshControlRoot(), `c-${key}.sock`);
}

/**
 * Build one independent RPC channel. OpenSSH's `auto` mode opportunistically
 * reuses a live master at this ControlPath; concurrent first connects may
 * briefly race before one master socket is visible, but each remains an
 * independent channel. ControlPersist keeps a discovered master alive after
 * any one channel closes, while retaining normal SSH config, user identity,
 * and host-key verification.
 */
export function sshRpcArguments(destination: string, executable: string, args: string[]): string[] {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(destination)) throw new Error('Invalid SSH destination');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = 'exec ' + [executable,...args].map(quote).join(' ');
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=90s',
    '-o', `ControlPath=${sshControlPath(destination)}`,
    destination,
    'sh', '-lc', quote(command),
  ];
}
