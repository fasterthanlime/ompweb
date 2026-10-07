"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { MessageView } from "@/components/MessageView";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { useAudio } from "@/hooks/useAudio";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useNodes, useRoom, useRooms, type RoomEntry } from "@/hooks/useRoom";
import { signOut, useMe } from "@/hooks/useMe";
import { NodeList } from "@/components/NodeList";
import { modelRoom, str, type RoomModel } from "@/lib/room-entries";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import type { AgentMessage } from "@/lib/types";

/**
 * A nookd room. Messages and tool blocks go through MessageView, so they
 * look like every other conversation in nook; the room's own kinds -
 * found/ask/claim, a non-expected ack, the teacher - are rows of their own
 * in the same column. The composer is ChatInput.
 */

const COLUMN_PADDING = 16;

function SignalRow({ e, open, asked }: { e: RoomEntry; open: Set<string>; asked: boolean }) {
  const b = e.body;
  const signal = str(b.signal);
  const ref = str(b.ref);
  // An answered question fades; an open one is the loudest thing on screen.
  const tone =
    signal === "claim" ? "var(--status-success)"
    : signal === "ask" ? (asked ? "var(--accent-strong)" : "var(--text-dim)")
    : signal === "found" ? "var(--accent)"
    : "var(--text)";
  const openList = Array.isArray(b.open) ? (b.open as string[]) : [];
  return (
    <div
      style={{
        display: "flex", alignItems: "baseline", gap: 8, minWidth: 0,
        margin: "6px 0", padding: "7px 10px",
        border: `1px solid color-mix(in srgb, ${tone} 28%, transparent)`,
        borderRadius: "var(--radius-control)",
        background: `color-mix(in srgb, ${tone} 5%, transparent)`,
        fontSize: 12.5,
      }}
    >
      <span style={{ color: tone, fontWeight: 600, flexShrink: 0 }}>{signal === "ask" ? (asked ? "question" : "asked") : signal}</span>
      {ref && <span style={{ fontFamily: "var(--font-mono)", color: open.has(ref) ? "var(--accent-strong)" : "var(--text-dim)", flexShrink: 0 }}>{ref}</span>}
      <span style={{ minWidth: 0 }}>{str(b.text)}</span>
      {signal === "claim" && openList.length > 0 && (
        <span style={{ marginLeft: "auto", color: "var(--accent-strong)", fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>open: {openList.join(" ")}</span>
      )}
    </div>
  );
}

function NoteRow({ label, text, tone }: { label: string; text: string; tone: string }) {
  return (
    <div style={{ margin: "6px 0", padding: "6px 10px", borderLeft: `2px solid ${tone}`, color: "var(--text-muted)", fontSize: 12 }}>
      <span style={{ color: tone, fontWeight: 600, marginRight: 6 }}>{label}</span>{text}
    </div>
  );
}

function Rows({ model }: { model: RoomModel }) {
  const { rows, toolResults, open, openAsks } = model;
  const openSeqs = new Set(openAsks.map(a => a.seq));
  return (
    <>
      {rows.map((row, i) => {
        const e = row.entry;
        if (row.message) {
          const prev = rows[i - 1]?.message;
          const showTimestamp = !prev || prev.role !== row.message.role || (e.created_at.slice(0, 16) !== rows[i - 1]!.entry.created_at.slice(0, 16));
          return (
            <MessageView
              key={e.seq}
              message={row.message as AgentMessage}
              toolResults={toolResults}
              entryId={e.id}
              showTimestamp={showTimestamp}
              prevTimestamp={prev?.timestamp}
              toolCallsDefaultCollapsed
            />
          );
        }
        if (e.kind === "signal") return <SignalRow key={e.seq} e={e} open={open} asked={openSeqs.has(e.seq)} />;
        if (e.kind === "teach") return <NoteRow key={e.seq} label="teacher" text={str(e.body.text)} tone="var(--accent-strong)" />;
        if (e.kind === "error") return <NoteRow key={e.seq} label="error" text={str(e.body.text)} tone="var(--status-error)" />;
        return null;
      })}
    </>
  );
}

/**
 * The "thought" line for a running turn: the latest status signal, else the
 * intent of a tool call still waiting on its result.
 */
function latestStatus(entries: RoomEntry[]): string | null {
  let pendingIntent: string | null = null;
  const answered = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "message" && e.body.role === "user") break;
    if (e.kind === "signal" && e.body.signal === "status") return str(e.body.text);
    if (e.kind === "tool_result") answered.add(str(e.body.id));
    if (e.kind === "tool_call" && !answered.has(str(e.body.id)) && !pendingIntent) {
      const args = e.body.arguments as Record<string, unknown> | undefined;
      pendingIntent = str(args?.i) || str(e.body.name);
    }
  }
  return pendingIntent;
}

function RoomStatus({ running, status, open }: { running: boolean; status: string | null; open: Set<string> }) {
  const reducedMotion = usePrefersReducedMotion();
  if (!running && open.size === 0) return null;
  return (
    <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28, padding: "4px 2px", color: "var(--text-muted)", fontSize: 12 }}>
      {running && <span aria-hidden className={`live-status-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent${reducedMotion ? "" : " live-pulse"}`} />}
      {running && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status ?? "Working"}</span>}
      {open.size > 0 && <span style={{ marginLeft: "auto", color: "var(--accent-strong)", fontFamily: "var(--font-mono)", fontSize: 11 }}>open: {[...open].join(" ")}</span>}
    </div>
  );
}

function RoomList({ rooms, error, loaded, selected, onSelect, onCreate }: {
  rooms: { id: string; name: string; last_at: string; running: boolean; expression: { kaomoji: string; caption: string } | null }[];
  error: string | null;
  loaded: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const relative = (iso: string) => {
    if (!now) return "";
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 10px 6px" }}>
        <Link href="/" aria-label="Back to nook" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-muted)", textDecoration: "none", fontSize: 12 }}>
          <ArrowLeft size={14} aria-hidden="true" /> nook
        </Link>
        <span style={{ marginLeft: 2, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>Rooms</span>
        <Link href={graphHref} style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", textDecoration: "none" }}>Graph</Link>
        <button
          type="button"
          onClick={() => setDraft(draft === null ? "" : null)}
          aria-label="New room"
          title="New room"
          style={{ marginLeft: "auto", display: "inline-flex", width: 26, height: 26, alignItems: "center", justifyContent: "center", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer" }}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      {draft !== null && (
        <form
          style={{ display: "flex", gap: 6, padding: "0 10px 8px" }}
          onSubmit={async ev => {
            ev.preventDefault();
            const name = draft.trim();
            if (name && (await onCreate(name))) setDraft(null);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={ev => setDraft(ev.target.value)}
            placeholder="room name"
            style={{ minWidth: 0, flex: 1, height: 30, padding: "0 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 13 }}
          />
          <button type="submit" style={{ height: 30, padding: "0 10px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>create</button>
        </form>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 8px" }}>
        {error && <div style={{ padding: "8px 10px", color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
        {!error && loaded && rooms.length === 0 && <div style={{ padding: "8px 10px", color: "var(--text-muted)", fontSize: 12 }}>no rooms yet</div>}
        {rooms.map(r => {
          const isSelected = r.id === selected;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.id)}
              aria-current={isSelected ? "true" : undefined}
              style={{
                position: "relative", display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 34, margin: "1px 0", padding: "0 8px",
                border: 0, borderRadius: "var(--radius-control)", textAlign: "left", cursor: "pointer", color: "var(--text)",
                background: isSelected ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)" : "transparent",
              }}
            >
              {isSelected && <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, borderRadius: 1, background: "var(--accent)" }} />}
              <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 1 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: isSelected ? 600 : 500 }}>{r.name}</span>
                {r.expression && (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-dim)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{r.expression.kaomoji}</span> {r.expression.caption}
                  </span>
                )}
              </span>
              {r.running && <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
              <span style={{ color: r.running ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{r.running ? "running" : relative(r.last_at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The signed-in handle; tap to sign out. */
function Who() {
  const me = useMe();
  if (!me) return null;
  return (
    <button
      type="button"
      onClick={() => { if (confirm(`Sign out ${me.handle}?`)) void signOut(); }}
      title={me.did}
      style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 12, background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}
    >
      @{me.handle}
    </button>
  );
}

/** Under nook the graph is /rooms/graph; served by nookd it is /graph. */
const graphHref = typeof location !== "undefined" && location.pathname.startsWith("/rooms") ? "/rooms/graph" : "/graph";

export function RoomView({ initialRoom }: { initialRoom: string | null }) {
  const isMobile = useIsMobile();
  const { rooms, error: roomsError, loaded, create } = useRooms(3000);
  const [roomId, setRoomId] = useState<string | null>(initialRoom);
  const { entries, connected, error, say, stop } = useRoom(roomId);
  const roomNodes = useNodes({ room: roomId ?? "", state: "open,doing,done,dropped" });
  const openQuestions = roomNodes.nodes.filter(n => n.node.tags.includes("question") && (n.node.state === "open" || n.node.state === "doing")).length;
  const model = modelRoom(entries);
  const [showList, setShowList] = useState(!initialRoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ChatInputHandle>(null);
  const { unlockAudio } = useAudio();

  const room = rooms.find(r => r.id === roomId);
  const running = room?.running ?? false;
  // The latest status signal in the current turn, if any: the "thought" line.
  const status = latestStatus(entries);
  const history = entries.filter(e => e.kind === "message" && e.body.role === "user").map(e => str(e.body.text));

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [entries.length]);
  useEffect(() => {
    // Under nook the app is at /rooms/<id>; served by nookd it is /r/<id>.
    if (roomId) window.history.replaceState(null, "", `${location.pathname.startsWith("/rooms") ? "/rooms" : "/r"}/${roomId}`);
  }, [roomId]);

  const select = useCallback((id: string) => { setRoomId(id); setShowList(false); }, []);
  const handleSend = useCallback(async (text: string) => say(text), [say]);
  const handleAbort = useCallback(() => { void stop(); }, [stop]);

  const list = (
    <RoomList
      rooms={rooms}
      error={roomsError}
      loaded={loaded}
      selected={roomId}
      onSelect={select}
      onCreate={async name => {
        const r = await create(name);
        if (r) select(r.id);
        return Boolean(r);
      }}
    />
  );

  return (
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)", color: "var(--text)" }}>
      {(!isMobile || showList) && (
        <aside style={{ width: isMobile ? "100%" : 260, flexShrink: 0, minHeight: 0, borderRight: isMobile ? 0 : "1px solid var(--border)", background: "var(--bg-panel)" }}>
          {list}
        </aside>
      )}
      {(!isMobile || !showList) && (
        <main style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
          <header style={{ display: "flex", alignItems: "center", gap: 8, height: 44, padding: `0 ${COLUMN_PADDING}px`, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {isMobile && (
              <button type="button" onClick={() => setShowList(true)} aria-label="Rooms" style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", padding: 0 }}>
                <ArrowLeft size={14} aria-hidden="true" /> rooms
              </button>
            )}
            <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{room?.name ?? (roomId ? roomId.slice(0, 8) : "no room")}</span>
            <span title={connected ? "Live" : "Reconnecting"} aria-label={connected ? "Live" : "Reconnecting"} style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "var(--status-success)" : "var(--text-dim)", flexShrink: 0 }} />
            {model.expression && (
              <span title={model.expression.caption} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, minWidth: 0, color: "var(--text-muted)", fontSize: 12 }}>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }}>{model.expression.kaomoji}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.expression.caption}</span>
              </span>
            )}
            {openQuestions > 0 && <span style={{ color: "var(--accent-strong)", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{openQuestions} open question{openQuestions === 1 ? "" : "s"}</span>}
            {error && <span style={{ color: "var(--status-error)", fontSize: 11 }}>{error}</span>}
            <Who />
          </header>
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto pt-6">
            <div style={{ padding: `0 ${COLUMN_PADDING}px` }}>
              <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
                {roomId && roomNodes.nodes.length > 0 && <NodeList compact title="nodes" nodes={roomNodes.nodes} onPatch={roomNodes.patch} onComment={roomNodes.comment} />}
                {roomId ? <Rows model={model} /> : <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 24, textAlign: "center" }}>Pick a room.</div>}
                <RoomStatus running={running} status={status} open={model.open} />
                <div ref={endRef} />
              </div>
            </div>
          </div>
          {roomId && (
            <div style={{ flexShrink: 0, padding: `0 ${COLUMN_PADDING}px` }}>
              <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
                <ChatInput
                  ref={inputRef}
                  onSend={handleSend}
                  onAbort={handleAbort}
                  isStreaming={running}
                  draftKey={`room:${roomId}`}
                  inputHistory={history}
                  onAudioUnlock={unlockAudio}
                />
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
