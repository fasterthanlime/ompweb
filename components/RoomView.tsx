"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { DictationControl } from "@/components/DictationControl";
import { useRoom, useRooms, type RoomEntry } from "@/hooks/useRoom";

/**
 * A nookd room, rendered as what it is: an ordered list of entries. Tool
 * calls show their intent; results show their ref and, once it lands, the
 * ack that paid for it. Surprises stay highlighted until resolved. No
 * adapter to the OMP session model - that is the point.
 */

const MARK = "🪧🦊";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Assistant text with its signal lines removed; they render as their own rows. */
function prose(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .filter(line => {
      const s = line.trim();
      if (s.startsWith("```")) fence = !fence;
      return fence || !s.startsWith(MARK);
    })
    .join("\n")
    .trim();
}

/** Ack signals by ref, latest wins; and the refs whose surprise is still open. */
function ackIndex(entries: RoomEntry[]) {
  const acks = new Map<string, RoomEntry>();
  const open = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "signal") continue;
    const ref = str(e.body.ref);
    if (!ref) continue;
    const signal = str(e.body.signal);
    if (signal === "ack") {
      acks.set(ref, e);
      if (e.body.verdict === "surprise") open.add(ref);
      else open.delete(ref);
    } else if (signal === "found" || signal === "ask") {
      open.delete(ref);
    }
  }
  return { acks, open };
}

function Time({ at }: { at: string }) {
  return <span className="tabular-nums" style={{ color: "var(--text-muted)", fontSize: 11 }}>{at.slice(11, 19)}</span>;
}

function Row({ e, acks, open }: { e: RoomEntry; acks: Map<string, RoomEntry>; open: Set<string> }) {
  const b = e.body;
  switch (e.kind) {
    case "message": {
      const mine = b.role === "user";
      const text = mine ? str(b.text) : prose(str(b.text));
      if (!text) return null;
      return (
        <div className="px-3 py-2" style={{ background: mine ? "var(--bg-panel)" : undefined, borderRadius: 8 }}>
          <div className="mb-1 flex items-baseline gap-2">
            <span style={{ fontWeight: 600, fontSize: 12 }}>{e.author}</span>
            <Time at={e.created_at} />
          </div>
          <MarkdownBody>{text}</MarkdownBody>
        </div>
      );
    }
    case "tool_call": {
      const args = b.arguments as Record<string, unknown> | undefined;
      const summary = str(args?.command) || str(args?.path) || str(args?.pattern) || str(args?.job) || "";
      return (
        <div className="px-3 py-1 font-mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          <span style={{ color: "var(--text)" }}>{str(b.name)}</span>
          {str(args?.i) && <span> · {str(args?.i)}</span>}
          {summary && <div className="truncate" title={summary}>{summary}</div>}
        </div>
      );
    }
    case "tool_result": {
      const ref = str(b.ref);
      const ack = ref ? acks.get(ref) : undefined;
      const failed = b.failed === true;
      const isOpen = ref !== "" && open.has(ref);
      const output = str(b.output);
      return (
        <details className="px-3 py-1" style={{ borderLeft: `3px solid ${isOpen ? "var(--accent-strong)" : failed ? "var(--status-error)" : "var(--border)"}` }}>
          <summary className="cursor-pointer font-mono" style={{ fontSize: 12 }}>
            {ref && <span style={{ fontWeight: 600 }}>{ref}</span>}
            {!ref && <span style={{ color: "var(--text-muted)" }}>refused</span>}
            {failed && <span style={{ color: "var(--status-error)" }}> failed</span>}
            {ack ? (
              <span style={{ color: ack.body.verdict === "expected" ? "var(--text-muted)" : "var(--accent-strong)" }}>
                {" "}· {str(ack.body.verdict)} {str(ack.body.text)}
              </span>
            ) : ref ? (
              <span style={{ color: "var(--text-muted)" }}> · unacked</span>
            ) : null}
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap" style={{ fontSize: 12, maxHeight: 400 }}>{output}</pre>
        </details>
      );
    }
    case "signal": {
      const signal = str(b.signal);
      if (signal === "ack" || signal === "status") return null;
      const ref = str(b.ref);
      const tone = signal === "claim" ? "var(--status-success)" : signal === "ask" ? "var(--accent-strong)" : "var(--text)";
      return (
        <div className="px-3 py-1" style={{ fontSize: 13 }}>
          <span style={{ fontWeight: 700, color: tone }}>{signal}</span>
          {ref && <span className="font-mono" style={{ color: "var(--text-muted)" }}> {ref}</span>}
          <span>: {str(b.text)}</span>
        </div>
      );
    }
    case "teach":
      return (
        <div className="px-3 py-1 italic" style={{ fontSize: 12, color: "var(--accent-strong)" }}>teacher: {str(b.text)}</div>
      );
    case "error":
      return <div className="px-3 py-1" style={{ fontSize: 12, color: "var(--status-error)" }}>error: {str(b.text)}</div>;
    default:
      return null;
  }
}

function Composer({ onSend, disabled }: { onSend: (text: string) => Promise<boolean>; disabled: boolean }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = async (t: string) => {
    const body = t.trim();
    if (!body) return;
    if (await onSend(body)) { setText(""); setPreview(""); }
  };
  return (
    <div className="flex items-end gap-2 border-t p-2" style={{ borderColor: "var(--border)" }}>
      <textarea
        ref={ref}
        value={preview ? `${text}${text ? " " : ""}${preview}` : text}
        onChange={ev => setText(ev.target.value)}
        onKeyDown={ev => {
          if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); void submit(text); }
        }}
        rows={2}
        placeholder="Say something to the room"
        className="flex-1 resize-none rounded-md p-2"
        style={{ background: "var(--bg-panel)", fontSize: 14 }}
        disabled={disabled}
      />
      <DictationControl
        sendLabel="Send"
        onPreview={p => setPreview(p)}
        onTranscript={(t, send) => {
          setPreview("");
          const next = text ? `${text} ${t}` : t;
          if (send) void submit(next); else setText(next);
        }}
      />
      <button
        type="button"
        onClick={() => void submit(text)}
        disabled={disabled || !text.trim()}
        className="rounded-md px-3 py-2"
        style={{ background: "var(--accent-strong)", color: "#fff", fontSize: 13 }}
      >
        Send
      </button>
    </div>
  );
}

export function RoomView({ initialRoom }: { initialRoom: string | null }) {
  const { rooms, create } = useRooms();
  const [roomId, setRoomId] = useState<string | null>(initialRoom);
  const { entries, connected, error, say } = useRoom(roomId);
  const { acks, open } = useMemo(() => ackIndex(entries), [entries]);
  const bottom = useRef<HTMLDivElement>(null);
  const [showList, setShowList] = useState(!initialRoom);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [entries.length]);
  useEffect(() => {
    if (roomId) window.history.replaceState(null, "", `/rooms/${roomId}`);
  }, [roomId]);

  const room = rooms.find(r => r.id === roomId);

  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <aside
        className={`${showList ? "flex" : "hidden"} w-full shrink-0 flex-col overflow-y-auto border-r md:flex md:w-64`}
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between p-2">
          <span style={{ fontWeight: 600 }}>Rooms</span>
          <button
            type="button"
            className="rounded px-2 py-1"
            style={{ fontSize: 12, background: "var(--bg-panel)" }}
            onClick={async () => {
              const name = window.prompt("Room name");
              if (!name) return;
              const r = await create(name);
              if (r) { setRoomId(r.id); setShowList(false); }
            }}
          >
            new
          </button>
        </div>
        {rooms.map(r => (
          <button
            key={r.id}
            type="button"
            onClick={() => { setRoomId(r.id); setShowList(false); }}
            className="flex items-center justify-between px-3 py-2 text-left"
            style={{ background: r.id === roomId ? "var(--bg-panel)" : undefined, fontSize: 13 }}
          >
            <span className="truncate">{r.name}</span>
            <span style={{ color: r.running ? "var(--accent-strong)" : "var(--text-muted)", fontSize: 11 }}>
              {r.running ? "running" : r.last_at.slice(5, 16).replace("T", " ")}
            </span>
          </button>
        ))}
      </aside>
      <main className={`${showList ? "hidden" : "flex"} min-w-0 flex-1 flex-col md:flex`}>
        <header className="flex items-center gap-2 border-b p-2" style={{ borderColor: "var(--border)" }}>
          <button type="button" className="md:hidden" onClick={() => setShowList(true)} style={{ fontSize: 13 }}>rooms</button>
          <span style={{ fontWeight: 600 }}>{room?.name ?? (roomId ? roomId.slice(0, 8) : "no room")}</span>
          <span style={{ fontSize: 11, color: connected ? "var(--status-success)" : "var(--text-muted)" }}>{connected ? "live" : "…"}</span>
          {open.size > 0 && <span style={{ fontSize: 11, color: "var(--accent-strong)" }}>open: {[...open].join(" ")}</span>}
          {error && <span style={{ fontSize: 11, color: "var(--status-error)" }}>{error}</span>}
          <Link href="/" className="ml-auto" style={{ fontSize: 12, color: "var(--text-muted)" }}>omp</Link>
        </header>
        <div className="flex-1 space-y-1 overflow-y-auto py-2">
          {entries.map(e => <Row key={e.seq} e={e} acks={acks} open={open} />)}
          <div ref={bottom} />
        </div>
        {roomId && <Composer onSend={t => say(t)} disabled={!roomId} />}
      </main>
    </div>
  );
}
