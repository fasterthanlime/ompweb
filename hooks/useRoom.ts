"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One row of a nookd room: the wire shape, unchanged. */
export interface RoomEntry {
  room_id: string;
  seq: number;
  id: string;
  kind: string;
  author: string;
  body: Record<string, unknown>;
  created_at: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  parent_id: string | null;
  last_seq: number;
  last_at: string;
  running: boolean;
  expression: { kaomoji: string; caption: string } | null;
}

/**
 * A room's entry list, kept live: one fetch for the backlog, then SSE from
 * the last seq seen. Reconnects resume from `Last-Event-ID`, so nothing is
 * missed or doubled.
 */
export function useRoom(roomId: string | null) {
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!roomId) return;
    setEntries([]);
    lastSeq.current = 0;
    setError(null);
    let source: EventSource | null = null;
    let cancelled = false;

    const append = (batch: RoomEntry[]) => {
      const fresh = batch.filter(e => e.seq > lastSeq.current);
      if (fresh.length === 0) return;
      lastSeq.current = fresh[fresh.length - 1]!.seq;
      setEntries(prev => [...prev, ...fresh]);
    };

    (async () => {
      // Backlog in pages; the stream then takes over from the cursor.
      for (;;) {
        const res = await fetch(`/api/rooms/${roomId}/entries?after=${lastSeq.current}&limit=1000`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) { setError(`entries: ${res.status}`); return; }
        const page = (await res.json()) as RoomEntry[];
        append(page);
        if (page.length < 1000) break;
      }
      if (cancelled) return;
      source = new EventSource(`/api/rooms/${roomId}/events?after=${lastSeq.current}`);
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      // nookd names each SSE event after the entry kind; listen for all of them.
      for (const kind of ["message", "tool_call", "tool_result", "signal", "teach", "error", "usage", "reasoning", "expression"]) {
        source.addEventListener(kind, ev => append([JSON.parse((ev as MessageEvent).data) as RoomEntry]));
      }
    })().catch(e => { if (!cancelled) setError(String(e)); });

    return () => {
      cancelled = true;
      source?.close();
      setConnected(false);
    };
  }, [roomId]);

  const say = useCallback(async (text: string, author = "amos") => {
    if (!roomId) return false;
    const res = await fetch(`/api/rooms/${roomId}/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author, text }),
    });
    return res.ok;
  }, [roomId]);

  const stop = useCallback(async () => {
    if (!roomId) return false;
    const res = await fetch(`/api/rooms/${roomId}/stop`, { method: "POST" });
    return res.ok;
  }, [roomId]);

  return { entries, connected, error, say, stop };
}

/** The room list, refreshed on an interval; cheap, and rooms rarely change. */
export function useRooms(intervalMs = 5000) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/rooms", { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `rooms: ${res.status}`);
        }
        if (!stop) { setRooms((await res.json()) as RoomSummary[]); setError(null); }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stop) setLoaded(true);
      }
    };
    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => { stop = true; clearInterval(timer); };
  }, [intervalMs]);
  const create = useCallback(async (name: string) => {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string };
  }, []);
  return { rooms, error, loaded, create };
}

/** A node as the API lists it: the row plus what a list needs beside it. */
export interface NodeRow {
  node: {
    id: string;
    title: string;
    body: string;
    state: "open" | "doing" | "done" | "dropped";
    assignee: string | null;
    project: string | null;
    tags: string[];
    priority: number;
    due: string | null;
    created_by: string;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
  };
  blocked_by: string[];
  rooms: string[];
}

export interface NodeQuery {
  assignee?: string;
  project?: string;
  tag?: string;
  state?: string;
  blocked?: boolean;
  room?: string;
}

export interface GraphEdge {
  from_id: string;
  to_id: string;
  kind: string;
}

/**
 * A narrowing of the graph, refreshed on an interval and on demand. With
 * `withEdges`, the edges among the result come too (and the nodes those
 * edges reach outside it), for drawing.
 */
export function useNodes(query: NodeQuery, intervalMs = 4000, withEdges = false) {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);
  const load = useCallback(async () => {
    const q = JSON.parse(key) as NodeQuery;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    try {
      const res = await fetch(`/api/nodes${withEdges ? "/graph" : ""}?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`nodes: ${res.status}`);
      if (withEdges) {
        const g = (await res.json()) as { nodes: NodeRow[]; edges: GraphEdge[] };
        setNodes(g.nodes);
        setEdges(g.edges);
      } else {
        setNodes((await res.json()) as NodeRow[]);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [key, withEdges]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs]);
  const patch = useCallback(async (id: string, body: Record<string, unknown>, actor = "amos") => {
    const res = await fetch(`/api/nodes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor, ...body }) });
    await load();
    return res.ok;
  }, [load]);
  const comment = useCallback(async (id: string, text: string, actor = "amos") => {
    const res = await fetch(`/api/nodes/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor, text }) });
    return res.ok;
  }, []);
  return { nodes, edges, error, reload: load, patch, comment };
}
