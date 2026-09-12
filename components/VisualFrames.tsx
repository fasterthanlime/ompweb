"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VisualFrame } from "@/lib/visual-frame";
import { sanitizeVisual } from "@/lib/visual-sanitize";
import { PanelsTopLeft } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./ui/primitives";

type FrameStore = { frames: VisualFrame[]; listeners: Set<() => void>; timer?: number; loading: boolean };
const stores = new Map<string, FrameStore>();

function storeFor(sessionId: string): FrameStore {
  const existing = stores.get(sessionId);
  if (existing) return existing;
  const created: FrameStore = { frames: [], listeners: new Set(), loading: false };
  stores.set(sessionId, created);
  return created;
}

function notify(store: FrameStore): void {
  for (const listener of store.listeners) listener();
}

async function refresh(sessionId: string, store: FrameStore): Promise<void> {
  if (store.loading) return;
  store.loading = true;
  try {
    const response = await fetch(`/api/thread-visuals/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as unknown;
    if (!Array.isArray(next)) return;
    store.frames = next.filter((frame): frame is VisualFrame => Boolean(frame && typeof frame === "object" && typeof (frame as VisualFrame).id === "string"));
    notify(store);
  } catch {
    // Visual polling is best-effort; the discussion remains usable if the route is unavailable.
  } finally {
    store.loading = false;
  }
}

function useSessionFrames(sessionId: string): VisualFrame[] {
  const store = storeFor(sessionId);
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      if (!store.timer) {
        void refresh(sessionId, store);
        store.timer = window.setInterval(() => void refresh(sessionId, store), 3000);
      }
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0 && store.timer) {
          clearInterval(store.timer);
          store.timer = undefined;
        }
      };
    },
    () => store.frames,
    () => [],
  );
}

function subscribeVisualTheme(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => observer.disconnect();
}

function useVisualTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeVisualTheme,
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
    () => "light",
  );
}

function Frame({ frame, theme }: { frame: VisualFrame; theme: "light" | "dark" }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const shadow = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
    try {
      const safe = sanitizeVisual(frame.html, frame.css);
      const style = document.createElement("style");
      style.textContent = [
        `:host{all:initial;display:block;color-scheme:${theme};color:light-dark(#272726,#ebe6dc);background:light-dark(#fafaf8,#1b1916);font:14px system-ui,sans-serif;line-height:1.5}`,
        ".card{padding:12px;border:1px solid light-dark(#dededa,#38322b);border-radius:8px;background:light-dark(#f1f1ee,#231f1b);color:light-dark(#272726,#ebe6dc)}.muted{color:light-dark(#62625f,#a39b8e);font-size:.9em}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}",
        "*{box-sizing:border-box;max-width:100%}svg{max-width:100%;height:auto}",
        safe.css,
      ].join("");
      const body = document.createElement("div");
      body.innerHTML = safe.html;
      shadow.replaceChildren(style, body);
      setError("");
    } catch {
      shadow.replaceChildren();
      setError("This visual exceeds the supported static format.");
    }
    return () => shadow.replaceChildren();
  }, [frame, theme]);

  return (
    <section data-visual-id={frame.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", margin: "12px 0", overflow: "hidden", background: "var(--bg-panel)" }}>
      <header style={{ display: "flex", gap: 8, padding: 10, alignItems: "center" }}>
        <strong style={{ flex: 1, fontSize: 13 }}>{frame.title}</strong>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Agent visual</span>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>v{frame.revision}</span>
        <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "Expand"}</button>
        <button type="button" onClick={() => void navigator.clipboard.writeText(`${frame.html}\n<style>\n${frame.css}\n</style>`)}>Copy source</button>
      </header>
      {error ? <p role="status" style={{ padding: "0 12px", color: "var(--status-error)" }}>{error}</p> : null}
      <div ref={host} style={{ contain: "layout paint style", isolation: "isolate", maxHeight: expanded ? "70vh" : 360, overflow: "auto", padding: 12 }} />
    </section>
  );
}

function frameMatchesAnchor(frame: VisualFrame, anchorIds: Set<string>): boolean {
  return (frame.originToolCallId !== undefined && anchorIds.has(frame.originToolCallId))
    || (frame.originHostToolCallId !== undefined && anchorIds.has(frame.originHostToolCallId));
}

function anchorIdsForFrame(frame: VisualFrame): Set<string> {
  return new Set([frame.originToolCallId, frame.originHostToolCallId].filter((id): id is string => Boolean(id)));
}
function historicalFrame(frame: VisualFrame, revision: NonNullable<VisualFrame["revisions"]>[number]): VisualFrame {
  return {
    id: `${frame.id}:revision:${revision.revision}`,
    title: `${revision.title} · v${revision.revision}`,
    html: revision.html,
    css: revision.css,
    createdAt: frame.createdAt,
    updatedAt: revision.updatedAt,
    revision: revision.revision,
    ...(frame.originToolCallId ? { originToolCallId: frame.originToolCallId } : {}),
    ...(frame.originHostToolCallId ? { originHostToolCallId: frame.originHostToolCallId } : {}),
  };
}
async function revealFrame(frame: VisualFrame, onReveal?: (frame: VisualFrame) => Promise<boolean> | boolean): Promise<boolean> {
  const existing = document.querySelector(`[data-visual-id="${CSS.escape(frame.id)}"]`);
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (existing) {
    existing.scrollIntoView({ behavior, block: "center" });
    return true;
  }
  if (onReveal && await onReveal(frame)) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 32));
    const revealed = document.querySelector(`[data-visual-id="${CSS.escape(frame.id)}"]`);
    if (revealed) {
      revealed.scrollIntoView({ behavior, block: "center" });
      return true;
    }
  }
  return false;
}

export function VisualFrames({
  sessionId,
  anchorToolCallId,
  anchorHostToolCallId,
  frameIds,
  mode = "anchor",
  onReveal,
}: {
  sessionId: string;
  anchorToolCallId?: string;
  anchorHostToolCallId?: string;
  frameIds?: string[];
  mode?: "anchor" | "index" | "history";
  onReveal?: (frame: VisualFrame) => Promise<boolean> | boolean;
}) {
  const frames = useSessionFrames(sessionId);
  const theme = useVisualTheme();
  const [indexOpen, setIndexOpen] = useState(false);
  const anchorIds = new Set([anchorToolCallId, anchorHostToolCallId].filter((id): id is string => Boolean(id)));
  const requestedIds = new Set((frameIds ?? []).filter((id) => typeof id === "string" && id.length > 0));
  const anchored = requestedIds.size > 0
    ? frames.filter((frame) => requestedIds.has(frame.id))
    : anchorIds.size > 0 ? frames.filter((frame) => frameMatchesAnchor(frame, anchorIds)) : [];
  const legacy = frames.filter((frame) => anchorIdsForFrame(frame).size === 0);
  const latest = frames.reduce<VisualFrame | undefined>((current, frame) => !current || (frame.updatedAt ?? frame.createdAt) > (current.updatedAt ?? current.createdAt) ? frame : current, undefined);

  if (mode === "index") {
    if (frames.length === 0) return null;
    return (
      <>
        <button type="button" className="shell-toolbar-btn ui-focus-ring" aria-label={`Visuals (${frames.length})`} title={`Visuals (${frames.length})`} onClick={() => setIndexOpen(true)}><PanelsTopLeft size={17} /></button>
        <Dialog open={indexOpen} onOpenChange={setIndexOpen}>
          <DialogContent>
            <DialogTitle>Visuals</DialogTitle><DialogClose />
            <button type="button" onClick={() => { if (latest) void revealFrame(latest, onReveal); }}>Jump to latest visual</button>
            {[...frames].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).map(frame => <Frame key={frame.id} frame={frame} theme={theme} />)}
            <VisualFrames sessionId={sessionId} mode="history" />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  if (mode === "history") {
    const revisionFrames = frames.flatMap((frame) => (frame.revisions ?? []).map((revision) => historicalFrame(frame, revision)));
    if (legacy.length === 0 && revisionFrames.length === 0) return null;
    return <details style={{ margin: "12px 0" }}><summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}>Visual history ({legacy.length + revisionFrames.length})</summary>{legacy.map((frame) => <Frame key={frame.id} frame={frame} theme={theme} />)}{revisionFrames.map((frame) => <Frame key={frame.id} frame={frame} theme={theme} />)}</details>;
  }
  if (requestedIds.size > 0) return <>{anchored.map((frame) => <Frame key={frame.id} frame={frame} theme={theme} />)}</>;
  if (anchored.length > 0) return <>{anchored.map((frame) => <Frame key={frame.id} frame={frame} theme={theme} />)}</>;
  return null;
}
