"use client";
import { useState } from "react";
export function AddTask({ onAdd }: { onAdd: (content: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form onSubmit={async event => { event.preventDefault(); if (!text.trim() || pending) return; setPending(true); setError(null); const sent = text; try { await onAdd(sent); setText(current => current === sent ? "" : current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add task"); } finally { setPending(false); } }} style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
    <div style={{ display: "flex", gap: 8 }}><input aria-label="New task" placeholder="Add a task without interrupting…" value={text} maxLength={2000} onChange={event => setText(event.target.value)} style={{ flex: 1, minWidth: 0, padding: 8, fontSize: 16, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)" }}/><button type="submit" disabled={pending || !text.trim()}>{pending ? "Adding…" : "Add"}</button></div>
    {error && <p role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{error}</p>}
  </form>;
}
