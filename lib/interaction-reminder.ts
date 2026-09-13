import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type { ReactionTarget } from "./thread-expression";
import {
  buildInteractionReminder,
  extractInteractionAlias,
  stripInteractionReminder,
} from "./interaction-reminder-text";

export const INTERACTION_REMINDERS_PATH_ENV = "OMP_WEB_INTERACTION_REMINDERS_PATH";
export const INTERACTION_REMINDERS_PATH = process.env[INTERACTION_REMINDERS_PATH_ENV]
  ?? join(homedir(), ".omp", "agent", "interaction-reminders.json");

/** Keep pending and canonical aliases bounded so prompts cannot grow storage forever. */
export const MAX_INTERACTION_REMINDER_ALIASES = 1_024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SESSION_ID_LENGTH = 256;

interface AliasRecord {
  sessionId: string;
  createdAt: number;
  status: "pending" | "mapped" | "failed";
  canonicalTargetId?: string;
}

interface AliasRegistryFile {
  version: 1;
  aliases: Record<string, AliasRecord>;
}


function validSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID_LENGTH;
}

function validAlias(alias: string): boolean {
  return UUID_RE.test(alias);
}

function cloneRecord(record: AliasRecord): AliasRecord {
  return { ...record };
}

function parseRegistry(raw: string): Map<string, AliasRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !record.aliases || typeof record.aliases !== "object" || Array.isArray(record.aliases)) return new Map();
  const aliases = new Map<string, AliasRecord>();
  for (const [alias, candidate] of Object.entries(record.aliases as Record<string, unknown>)) {
    if (!validAlias(alias) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (!validSessionId(value.sessionId as string)
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)
      || (value.status !== "pending" && value.status !== "mapped" && value.status !== "failed")) continue;
    if (value.status === "mapped" && (typeof value.canonicalTargetId !== "string" || value.canonicalTargetId.length === 0)) continue;
    aliases.set(alias, {
      sessionId: value.sessionId as string,
      createdAt: value.createdAt as number,
      status: value.status,
      ...(value.status === "mapped" ? { canonicalTargetId: value.canonicalTargetId as string } : {}),
    });
  }
  return new Map([...aliases.entries()].slice(-MAX_INTERACTION_REMINDER_ALIASES));
}

function loadAliases(): Map<string, AliasRecord> {
  if (!existsSync(INTERACTION_REMINDERS_PATH)) return new Map();
  try {
    return parseRegistry(readFileSync(INTERACTION_REMINDERS_PATH, "utf8"));
  } catch {
    return new Map();
  }
}

function persistAliases(aliases: Map<string, AliasRecord>): void {
  const directory = dirname(INTERACTION_REMINDERS_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bounded = [...aliases.entries()].slice(-MAX_INTERACTION_REMINDER_ALIASES);
  const value: AliasRegistryFile = {
    version: 1,
    aliases: Object.fromEntries(bounded.map(([alias, record]) => [alias, cloneRecord(record)])),
  };
  const temporary = `${INTERACTION_REMINDERS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, INTERACTION_REMINDERS_PATH);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function ensureSessionId(sessionId: string): void {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id");
}

function createAlias(sessionId: string): string {
  ensureSessionId(sessionId);
  const aliases = loadAliases();
  let alias = randomUUID();
  while (aliases.has(alias)) alias = randomUUID();
  aliases.set(alias, { sessionId, createdAt: Date.now(), status: "pending" });
  while (aliases.size > MAX_INTERACTION_REMINDER_ALIASES) {
    const oldest = aliases.keys().next().value;
    if (oldest === undefined) break;
    aliases.delete(oldest);
  }
  persistAliases(aliases);
  return alias;
}

function expressionAge(expressionUpdatedAt: number | undefined): string {
  if (typeof expressionUpdatedAt !== "number" || !Number.isFinite(expressionUpdatedAt)) return "unknown";
  return `${Math.max(0, Date.now() - expressionUpdatedAt)}ms`;
}

export interface InteractionExpression {
  expression: string;
  caption: string;
  expressionUpdatedAt?: number;
}

/**
 * Append a server-owned interaction sidecar to a real user prompt. A slash
 * command remains byte-for-byte native. Every submission receives a fresh
 * alias, including copied or resent messages carrying an earlier sidecar.
 */
export function prepareInteractionPrompt(
  sessionId: string,
  message: string,
  expression?: InteractionExpression,
): string {
  ensureSessionId(sessionId);
  if (typeof message !== "string") throw new Error("Prompt message must be a string");
  if (/^\s*\//u.test(message)) return message;

  if (extractInteractionAlias(message)) message = stripInteractionReminder(message);

  const alias = createAlias(sessionId);
  return `${message}\n\n${buildInteractionReminder(
    alias,
    expression?.expression ?? "",
    expression?.caption ?? "",
    expressionAge(expression?.expressionUpdatedAt),
  )}`;
}

function failAlias(sessionId: string, alias: string, message: string): never {
  const aliases = loadAliases();
  const record = aliases.get(alias);
  if (record?.sessionId === sessionId && record.status === "pending") {
    aliases.set(alias, { ...record, status: "failed" });
    persistAliases(aliases);
  }
  throw new Error(message);
}

/**
 * Resolve an agent-supplied id to a native target id. Native ids are accepted
 * only when they are present in this bounded target list; all other ids must
 * be registered UUID aliases from a generated sidecar.
 */
export function resolveInteractionAlias(
  sessionId: string,
  id: string,
  targets: ReactionTarget[],
): string {
  ensureSessionId(sessionId);
  if (typeof id !== "string" || !id) throw new Error("Message target is required");
  if (!Array.isArray(targets)) throw new Error("Reaction targets are invalid");

  const direct = targets.filter((target) => target && target.id === id);
  if (direct.length === 1) return id;
  if (direct.length > 1) throw new Error("Message target is ambiguous");
  if (!validAlias(id)) throw new Error("Unknown interaction reminder alias");

  const aliases = loadAliases();
  const record = aliases.get(id);
  if (!record || record.sessionId !== sessionId) throw new Error("Unknown interaction reminder alias");
  if (targets.filter(target => target.reminderAlias === id).length > 1) throw new Error("Interaction reminder target is ambiguous");
  if (record.status === "failed") throw new Error("Interaction reminder alias was already rejected");

  if (record.status === "mapped") {
    const canonical = targets.filter((target) => target && target.id === record.canonicalTargetId);
    if (canonical.length !== 1) throw new Error("Mapped interaction reminder target is no longer available");
    if (canonical[0].reminderAlias && canonical[0].reminderAlias !== id) throw new Error("Mapped interaction reminder target changed");
    return record.canonicalTargetId!;
  }

  const matches = targets.filter((target) => target && target.reminderAlias === id);
  if (matches.length === 0) throw new Error("Interaction reminder target not found yet");
  if (matches.length > 1) return failAlias(sessionId, id, "Interaction reminder target is ambiguous");

  const canonicalTargetId = matches[0].id;
  if (typeof canonicalTargetId !== "string" || canonicalTargetId.length === 0) return failAlias(sessionId, id, "Interaction reminder target is invalid");
  aliases.set(id, { ...record, status: "mapped", canonicalTargetId });
  persistAliases(aliases);
  return canonicalTargetId;
}
