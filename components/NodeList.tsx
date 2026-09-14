"use client";

import { useState } from "react";
import type { NodeRow } from "@/hooks/useRoom";

/**
 * A narrowing of the graph as a list. Used above a room (that room's
 * nodes) and as the graph page (whatever the filter says). A node is a
 * row: state mark, title, who holds it, when it is due, what blocks it.
 * Tapping opens it; from there the human can close, reopen, or comment.
 */

const MARK: Record<NodeRow["node"]["state"], string> = { open: "○", doing: "◐", done: "●", dropped: "×" };

export function short(id: string): string {
  return id.replace(/-/g, "").slice(-6);
}

function dueLabel(iso: string): { text: string; late: boolean } {
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${-days}d late`, late: true };
  if (days === 0) return { text: "today", late: false };
  if (days === 1) return { text: "tomorrow", late: false };
  if (days < 14) return { text: `${days}d`, late: false };
  return { text: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), late: false };
}

export function NodeList({ nodes, title, compact, onPatch, onComment }: {
  nodes: NodeRow[];
  title?: string;
  compact?: boolean;
  onPatch?: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  onComment?: (id: string, text: string) => Promise<boolean>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const done = nodes.filter(n => n.node.state === "done").length;
  const byId = new Map(nodes.map(n => [n.node.id, n]));
  const closeWith = async (n: NodeRow, state: "done" | "dropped") => {
    if (!onPatch) return;
    const text = reason.trim();
    if (text && onComment) await onComment(n.node.id, text);
    if (await onPatch(n.node.id, { state })) { setReason(""); setOpenId(null); }
  };
  return (
    <div style={{ margin: compact ? "0 0 12px" : 0, padding: compact ? "8px 12px" : "0 4px", border: compact ? "1px solid var(--border)" : 0, borderRadius: "var(--radius-control)", background: compact ? "var(--bg-subtle)" : "transparent", fontSize: 12.5 }}>
      {title && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {title} <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>{done}/{nodes.length}</span>
        </div>
      )}
      {nodes.length === 0 && <div style={{ color: "var(--text-dim)", padding: "4px 0" }}>nothing here</div>}
      {nodes.map(r => {
        const n = r.node;
        const closed = n.state === "done" || n.state === "dropped";
        const blocked = r.blocked_by.filter(b => byId.get(b)?.node.state !== "done");
        const isOpen = openId === n.id;
        const due = n.due ? dueLabel(n.due) : null;
        return (
          <div key={n.id} style={{ borderTop: compact ? 0 : "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => { setOpenId(isOpen ? null : n.id); setReason(""); }}
              style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", padding: compact ? "2px 0" : "8px 4px", border: 0, background: "none", textAlign: "left", cursor: "pointer", font: "inherit", color: closed ? "var(--text-dim)" : "var(--text)", textDecoration: n.state === "dropped" ? "line-through" : undefined }}
            >
              <span aria-label={n.state} style={{ flexShrink: 0, color: n.state === "doing" ? "var(--accent)" : blocked.length ? "var(--accent-strong)" : "inherit", fontFamily: "var(--font-mono)" }}>{blocked.length && !closed ? "◌" : MARK[n.state]}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: isOpen ? "normal" : "nowrap" }}>{n.title}</span>
              {n.assignee && <span style={{ flexShrink: 0, color: n.assignee === "amos" ? "var(--accent)" : "var(--text-muted)", fontSize: 11 }}>@{n.assignee}</span>}
              {due && !closed && <span style={{ flexShrink: 0, color: due.late ? "var(--status-error)" : "var(--text-muted)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{due.text}</span>}
              {n.priority > 0 && !closed && <span style={{ flexShrink: 0, color: "var(--accent-strong)", fontSize: 10, fontWeight: 700 }}>p{n.priority}</span>}
            </button>
            {isOpen && (
              <div style={{ padding: "0 4px 10px 22px", color: "var(--text-muted)", fontSize: 12 }}>
                {n.body && n.body !== n.title && <div style={{ whiteSpace: "pre-wrap", color: "var(--text)", marginBottom: 6 }}>{n.body}</div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  <span>{short(n.id)}</span>
                  {n.project && <span>#{n.project}</span>}
                  {n.tags.map(t => <span key={t}>·{t}</span>)}
                  {blocked.length > 0 && <span style={{ color: "var(--accent-strong)" }}>blocked by {blocked.map(b => byId.get(b)?.node.title ?? short(b)).join(", ")}</span>}
                  <span>by {n.created_by}</span>
                </div>
                {onPatch && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {!closed && (
                      <input
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        placeholder={n.tags.includes("question") ? "your answer" : "why (optional)"}
                        style={{ flex: "1 1 160px", minWidth: 0, height: 30, padding: "0 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 13 }}
                        onKeyDown={e => { if (e.key === "Enter") void closeWith(r, "done"); }}
                      />
                    )}
                    {!closed && <button type="button" onClick={() => void closeWith(r, "done")} style={btn("var(--status-success)")}>done</button>}
                    {!closed && n.state !== "doing" && <button type="button" onClick={() => void onPatch(n.id, { state: "doing" })} style={btn("var(--accent)")}>doing</button>}
                    {!closed && <button type="button" onClick={() => void closeWith(r, "dropped")} style={btn("var(--text-muted)")}>drop</button>}
                    {closed && <button type="button" onClick={() => void onPatch(n.id, { state: "open" })} style={btn("var(--accent)")}>reopen</button>}
                    {n.assignee !== "amos" && !closed && <button type="button" onClick={() => void onPatch(n.id, { assignee: "amos" })} style={btn("var(--text-muted)")}>take</button>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return { height: 30, padding: "0 10px", border: `1px solid ${color}`, borderRadius: "var(--radius-control)", background: "transparent", color, fontSize: 12, fontWeight: 600, cursor: "pointer" };
}
