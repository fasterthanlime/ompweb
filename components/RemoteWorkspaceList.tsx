"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Circle } from "lucide-react";
import { HostMark, ThreadExpressionMeta } from "./ThreadList";

export type RemoteTargetSummary = {
  id: string;
  name: string;
  cwd: string;
  hostname?: string;
  platform?: string;
};

export type RemoteThreadSummary = {
  id: string;
  targetId: string;
  name: string;
  cwd: string;
  connected: boolean;
  modified?: string;
  running?: boolean;
  runningSince?: number;
  target: RemoteTargetSummary;
};


export function RemoteWorkspaceList({ selected, onSelect, refreshKey, onTargetsChange, onThreadsChange, renderRows = true }: {
  selected: { targetId: string; sessionId: string | null } | null;
  onSelect: (targetId: string, sessionId: string | null) => void;
  refreshKey: number;
  onTargetsChange?: (targets: RemoteTargetSummary[]) => void;
  onThreadsChange?: (threads: RemoteThreadSummary[]) => void;
  renderRows?: boolean;
}) {
  const [targets, setTargets] = useState<RemoteTargetSummary[]>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; targetId: string; name: string; cwd: string; connected: boolean }>>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/remote", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Unable to load SSH sessions");
        const data = await response.json() as { targets?: RemoteTargetSummary[]; sessions?: Array<{ id: string; targetId: string; name: string; cwd: string; connected: boolean }> };
        const nextTargets = data.targets ?? [];
        const nextSessions = data.sessions ?? [];
        setTargets(nextTargets);
        setSessions(nextSessions);
        const targetById = new Map(nextTargets.map((target) => [target.id, target]));
        onTargetsChange?.(nextTargets);
        onThreadsChange?.(nextSessions.flatMap((session) => {
          const target = targetById.get(session.targetId);
          return target ? [{ ...session, target }] : [];
        }));
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "SSH session error");
      }
    };
    void load();
    const interval = setInterval(() => void load(), 15000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refreshKey, onTargetsChange, onThreadsChange]);

  if (!renderRows) return null;
  if (error) return <div role="status" style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 11 }}>{error}</div>;
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const rows: ReactNode[] = sessions.flatMap((session) => {
    const target = targetById.get(session.targetId);
    if (!target) return [];
    const active = selected?.targetId === session.targetId && selected.sessionId === session.id;
    const tooltip = [target.name, target.hostname ?? target.id, session.cwd].filter(Boolean).join(" · ");
    const title = session.name || session.id.slice(0, 12);
    return [
      <button type="button" key={session.id} onClick={() => onSelect(session.targetId, session.id)} title={tooltip} aria-current={active ? "true" : undefined} style={{ width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 8, margin: "1px 0", padding: "5px 8px", border: 0, borderRadius: "var(--radius-control)", background: active ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}>
        <span aria-hidden="true" style={{ width: 2, height: 20, borderRadius: 1, background: active ? "var(--accent)" : "transparent", flexShrink: 0 }} />
        <HostMark platform={target.platform} />
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: active ? 600 : 500 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, color: "var(--text-dim)", fontSize: 10 }}><ThreadExpressionMeta id={session.id} enabled={active} /></span>
        </span>
        <span title={session.connected ? "Connected" : "Disconnected"} style={{ display: "inline-flex", alignItems: "center", color: session.connected ? "var(--accent)" : "var(--text-dim)" }}><Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden="true" /></span>
      </button>,
    ];
  });
  return <>{rows}</>;
}
