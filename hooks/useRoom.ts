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
      for (const kind of ["message", "tool_call", "tool_result", "signal", "teach", "error", "usage", "reasoning"]) {
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

  return { entries, connected, error, say };
}

/** The room list, refreshed on an interval; cheap, and rooms rarely change. */
export function useRooms(intervalMs = 5000) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/rooms", { cache: "no-store" });
        if (!res.ok) throw new Error(`rooms: ${res.status}`);
        if (!stop) { setRooms((await res.json()) as RoomSummary[]); setError(null); }
      } catch (e) {
        if (!stop) setError(String(e));
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
  return { rooms, error, create };
}
