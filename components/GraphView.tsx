"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { NodeList } from "@/components/NodeList";
import { useNodes } from "@/hooks/useRoom";

/**
 * The graph, narrowed. Views are saved filters over the same rows; these
 * are the ones a human reaches for on a phone. The elder's are the same
 * queries.
 */
const VIEWS: { id: string; label: string; query: Record<string, string | boolean> }[] = [
  { id: "mine", label: "mine", query: { assignee: "amos" } },
  { id: "questions", label: "questions", query: { assignee: "amos", tag: "question" } },
  { id: "doing", label: "doing", query: { state: "doing" } },
  { id: "blocked", label: "blocked", query: { blocked: true } },
  { id: "open", label: "all open", query: {} },
  { id: "done", label: "done", query: { state: "done" } },
];

const roomsHref = typeof location !== "undefined" && location.pathname.startsWith("/rooms") ? "/rooms" : "/";

export function GraphView() {
  const [view, setView] = useState("mine");
  const [project, setProject] = useState("");
  const current = VIEWS.find(v => v.id === view) ?? VIEWS[0]!;
  const { nodes, error, patch, comment } = useNodes({ ...current.query, ...(project ? { project } : {}) });
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden", background: "var(--bg)", color: "var(--text)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, height: 44, padding: "0 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <Link href={roomsHref} aria-label="Rooms" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-muted)", textDecoration: "none", fontSize: 12 }}>
          <ArrowLeft size={14} aria-hidden="true" /> rooms
        </Link>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Graph</span>
        <input
          value={project}
          onChange={e => setProject(e.target.value)}
          placeholder="project"
          style={{ marginLeft: "auto", width: 110, height: 28, padding: "0 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", font: "inherit", fontSize: 12 }}
        />
      </header>
      <div style={{ display: "flex", gap: 4, padding: "8px 12px", overflowX: "auto", flexShrink: 0 }}>
        {VIEWS.map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            style={{ flexShrink: 0, height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 999, background: v.id === view ? "var(--bg-selected)" : "var(--bg-panel)", color: v.id === view ? "var(--text)" : "var(--text-muted)", fontSize: 12, fontWeight: v.id === view ? 600 : 500, cursor: "pointer" }}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 16px" }}>
        {error && <div style={{ padding: 8, color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
        <NodeList nodes={nodes} onPatch={patch} onComment={comment} />
      </div>
    </div>
  );
}
