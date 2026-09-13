import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_VISUAL_FRAMES = 12;
export const MAX_VISUAL_REVISIONS = 64;

export interface VisualFrameRevision {
  revision: number;
  title: string;
  html: string;
  css: string;
  updatedAt: number;
}

export interface VisualFrame {
  id: string;
  title: string;
  html: string;
  css: string;
  createdAt: number;
  updatedAt?: number;
  /** Monotonically increasing revision, bounded to avoid an unbounded artifact history. */
  revision: number;
  /** Prior source snapshots, retained for bounded artifact history/export. */
  revisions?: VisualFrameRevision[];
  /** The assistant tool-call block this artifact belongs beside. */
  originToolCallId?: string;
  /** The server host_tool_call request id, retained for diagnostics/fallback anchoring. */
  originHostToolCallId?: string;
}

const root = join(homedir(), ".omp", "agent", "nook-visuals");

function file(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session identity");
  return join(root, `${id}.json`);
}

function normalizeFrame(raw: unknown): VisualFrame | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || typeof value.title !== "string" || typeof value.html !== "string" || typeof value.css !== "string") return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const revision = typeof value.revision === "number" && Number.isFinite(value.revision) && value.revision > 0
    ? Math.min(MAX_VISUAL_REVISIONS, Math.floor(value.revision))
    : 1;
  const revisions = Array.isArray(value.revisions)
    ? value.revisions.filter((entry): entry is VisualFrameRevision => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.revision === "number" && Number.isFinite(candidate.revision)
        && typeof candidate.title === "string" && typeof candidate.html === "string" && typeof candidate.css === "string"
        && typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt);
    }).slice(-MAX_VISUAL_REVISIONS)
    : undefined;
  return {
    id: value.id,
    title: value.title,
    html: value.html,
    css: value.css,
    createdAt,
    ...(typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    revision,
    ...(revisions?.length ? { revisions } : {}),
    ...(typeof value.originToolCallId === "string" && value.originToolCallId ? { originToolCallId: value.originToolCallId } : {}),
    ...(typeof value.originHostToolCallId === "string" && value.originHostToolCallId ? { originHostToolCallId: value.originHostToolCallId } : {}),
  };
}

export async function getVisualFrames(id: string): Promise<VisualFrame[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(id), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeFrame).filter((frame): frame is VisualFrame => frame !== null).slice(-MAX_VISUAL_FRAMES);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const queues = new Map<string, Promise<unknown>>();

const frameProperties = {
  id: { type: "string", maxLength: 100, description: "Existing visual id for update/remove." },
  title: { type: "string", maxLength: 120 },
  html: { type: "string", maxLength: 40000 },
  css: { type: "string", maxLength: 12000 },
};

export const VISUAL_TOOL = {
  name: "show_visual",
  label: "Show visual",
  loadMode: "essential",
  description: [
    "Create or manage a static HTML/CSS/SVG explanatory visual attached to the current discussion tool call.",
    "Actions are create (default), update, remove, and list. Create requires title and html; update/remove require id; list takes no fields.",
    "No scripts, network, forms, navigation, animation, external assets, or Nook-control imitations. Keep the artifact concise and explanatory.",
    "Use classes and ordinary safe CSS only. For custom colors, use light-dark(light-color, dark-color), and always provide readable default classes, type, spacing, and surfaces.",
    "Semantic layout tags and inert mock buttons are supported. Safe width/color-scheme media queries, gradients, shadows, and overflow are supported; use class-based CSS, not inline styles. The renderer sanitizes everything again and warns when unsupported markup/styles are removed.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "update", "remove", "list"], default: "create" },
      ...frameProperties,
    },
    additionalProperties: false,
  },
};

type VisualToolOrigin = { toolCallId?: string; hostToolCallId?: string };

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

export async function handleVisualTool(sessionId: string, args: unknown, origin: VisualToolOrigin = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Visual arguments required");
  const input = args as Record<string, unknown>;
  const action = input.action === undefined ? "create" : input.action;
  if (action !== "create" && action !== "update" && action !== "remove" && action !== "list") throw new Error("Unknown visual action");

  const pending = (queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const frames = await getVisualFrames(sessionId);
    const now = Date.now();

    if (action === "list") {
      return textResult(JSON.stringify(frames.map(({ id, title, createdAt, updatedAt, revision, originToolCallId }) => ({ id, title, createdAt, updatedAt, revision, originToolCallId }))));
    }

    const id = typeof input.id === "string" ? input.id : "";
    if (action === "remove") {
      if (!id) throw new Error("Visual id is required for remove");
      const index = frames.findIndex((frame) => frame.id === id);
      if (index < 0) throw new Error("Visual not found");
      frames.splice(index, 1);
      await persistVisualFrames(sessionId, frames);
      return textResult(`Visual ${id} removed.`);
    }

    if (action === "update") {
      if (!id) throw new Error("Visual id is required for update");
      const index = frames.findIndex((frame) => frame.id === id);
      if (index < 0) throw new Error("Visual not found");
      const current = frames[index];
      if (current.revision >= MAX_VISUAL_REVISIONS) throw new Error("Visual revision limit reached");
      if (input.title !== undefined && (!validText(input.title, 120) || !input.title.trim())) throw new Error("Invalid visual title");
      if (input.html !== undefined && !validText(input.html, 40000)) throw new Error("Invalid or oversized visual html");
      if (input.css !== undefined && !validText(input.css, 12000)) throw new Error("Invalid or oversized visual css");
      const previousRevision: VisualFrameRevision = {
        revision: current.revision,
        title: current.title,
        html: current.html,
        css: current.css,
        updatedAt: current.updatedAt ?? current.createdAt,
      };
      frames[index] = {
        ...current,
        ...(input.title !== undefined ? { title: input.title as string } : {}),
        ...(input.html !== undefined ? { html: input.html as string } : {}),
        ...(input.css !== undefined ? { css: input.css as string } : {}),
        updatedAt: now,
        revision: current.revision + 1,
        revisions: [...(current.revisions ?? []), previousRevision].slice(-MAX_VISUAL_REVISIONS),
      };
      await persistVisualFrames(sessionId, frames);
      return textResult(`Visual ${id} updated (revision ${frames[index].revision}).`);
    }

    const title = input.title;
    const html = input.html;
    const css = input.css ?? "";
    if (!validText(title, 120) || !title.trim() || !validText(html, 40000) || !validText(css, 12000)) {
      throw new Error("Invalid or oversized visual");
    }
    const frame: VisualFrame = {
      id: randomUUID(),
      title,
      html,
      css,
      createdAt: now,
      revision: 1,
      ...(typeof origin.toolCallId === "string" && origin.toolCallId ? { originToolCallId: origin.toolCallId } : {}),
      ...(typeof origin.hostToolCallId === "string" && origin.hostToolCallId ? { originHostToolCallId: origin.hostToolCallId } : {}),
    };
    await persistVisualFrames(sessionId, [...frames, frame].slice(-MAX_VISUAL_FRAMES));
    return textResult(`Visual ${frame.id} saved. Nook renders a restricted static version; scripts and unsafe styles are not supported.`);
  });

  queues.set(sessionId, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(sessionId) === pending) queues.delete(sessionId);
  }
}

async function persistVisualFrames(sessionId: string, frames: VisualFrame[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dest = file(sessionId);
  const temp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(frames.slice(-MAX_VISUAL_FRAMES)), { mode: 0o600 });
  await rename(temp, dest);
}
