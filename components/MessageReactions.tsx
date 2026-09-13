"use client";

import { toast } from "./ui/toast";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, SmilePlus, Sparkles } from "lucide-react";
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";
import { Popover } from "@base-ui/react/popover";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { isRecord } from "@/lib/type-guards";

const COMMON_REACTIONS = [
  "👍", "❤️", "😂", "🎉", "🙏", "🔥", "🚀", "👏",
  "✅", "💯", "😍", "🤔", "👀", "😅", "🙌", "💡",
  "😢", "😮", "😡", "🤝", "❤️‍🔥", "✨", "🎯", "⭐",
];

function isValidReactionEmoji(value: string): boolean {
  if (!value || [...value].length > 16) return false;
  const segments = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    : [...value];
  if (segments.length !== 1) return false;
  return /\p{Emoji}/u.test(value)
    && /^(?:[\p{Emoji}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3])+$/u.test(value)
    && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3)/u.test(value);
}

type ReactionActor = "user" | "agent";
export type MessageReaction = { emoji: string; actor: ReactionActor };
export type Celebration = { id: string; effect: "confetti" | "sparkles"; messageId: string };
export type ThreadExpressionState = {
  expression: string;
  caption: string;
  reactions: Record<string, MessageReaction[]>;
  celebration?: Celebration;
};

type Store = {
  state: ThreadExpressionState;
  listeners: Set<() => void>;
  loaded: boolean;
  loading?: Promise<void>;
  source?: EventSource;
};

const EMPTY_STATE: ThreadExpressionState = { expression: "", caption: "", reactions: {} };
const stores = new Map<string, Store>();
const CELEBRATION_STORAGE_KEY = "omp-celebrations-enabled";
const CELEBRATION_EVENT = "omp-celebrations-pref-change";

function normalizeReaction(value: unknown): MessageReaction | null {
  if (!isRecord(value) || typeof value.emoji !== "string" || !value.emoji || (value.actor !== "user" && value.actor !== "agent")) return null;
  return { emoji: value.emoji, actor: value.actor };
}

function normalizeState(value: unknown): ThreadExpressionState | null {
  const candidate = isRecord(value) && isRecord(value.state) ? value.state : value;
  if (!isRecord(candidate)) return null;
  const reactions: Record<string, MessageReaction[]> = {};
  if (isRecord(candidate.reactions)) {
    for (const [messageId, raw] of Object.entries(candidate.reactions)) {
      if (!Array.isArray(raw)) continue;
      const valid = raw.map(normalizeReaction).filter((reaction): reaction is MessageReaction => reaction !== null);
      if (valid.length > 0) reactions[messageId] = valid.slice(0, 24);
    }
  }
  const rawCelebration = candidate.celebration;
  const celebration: Celebration | undefined = isRecord(rawCelebration)
    && typeof rawCelebration.id === "string"
    && (rawCelebration.effect === "confetti" || rawCelebration.effect === "sparkles")
    && typeof rawCelebration.messageId === "string"
    ? { id: rawCelebration.id, effect: rawCelebration.effect, messageId: rawCelebration.messageId }
    : undefined;
  return {
    expression: typeof candidate.expression === "string" ? candidate.expression : "",
    caption: typeof candidate.caption === "string" ? candidate.caption : "",
    reactions,
    ...(celebration ? { celebration } : {}),
  };
}

function notify(store: Store): void {
  for (const listener of store.listeners) listener();
}

function applySnapshot(store: Store, value: unknown): void {
  const next = normalizeState(value);
  if (!next) return;
  store.state = next;
  store.loaded = true;
  notify(store);
}

function expressionUrl(threadId: string): string {
  return `/api/thread-expression/${encodeURIComponent(threadId)}`;
}

function ensureStore(threadId: string): Store {
  const existing = stores.get(threadId);
  if (existing) return existing;
  const store: Store = { state: EMPTY_STATE, listeners: new Set(), loaded: false };
  stores.set(threadId, store);
  store.loading = fetch(expressionUrl(threadId), { cache: "no-store" })
    .then(async response => {
      if (!response.ok) return;
      applySnapshot(store, await response.json());
    })
    .catch(() => undefined);
  if (typeof window !== "undefined" && typeof EventSource !== "undefined") {
    try {
      const source = new EventSource(`${expressionUrl(threadId)}/events`);
      source.onmessage = event => {
        try { applySnapshot(store, JSON.parse(event.data)); } catch { /* Ignore malformed snapshots. */ }
      };
      source.onerror = () => {
        // EventSource performs its own bounded reconnect backoff.
      };
      store.source = source;
    } catch {
      // A blocked EventSource should not disable the picker or persisted POSTs.
    }
  }
  return store;
}

export function useThreadExpression(threadId: string | undefined): ThreadExpressionState {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!threadId || typeof window === "undefined") return;
    const store = ensureStore(threadId);
    const listener = () => setVersion(version => version + 1);
    store.listeners.add(listener);
    setVersion(version => version + 1);
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        store.source?.close();
        if (stores.get(threadId) === store) stores.delete(threadId);
      }
    };
  }, [threadId]);
  if (!threadId || typeof window === "undefined") return EMPTY_STATE;
  return stores.get(threadId)?.state ?? EMPTY_STATE;
}

async function postAction(threadId: string, action: Record<string, unknown>): Promise<ThreadExpressionState | null> {
  const response = await fetch(expressionUrl(threadId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload.notificationError === "string") toast.error(payload.notificationError);
  return normalizeState(payload);
}

function readCelebrationsPreference(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(CELEBRATION_STORAGE_KEY) === "true"; } catch { return false; }
}

function writeCelebrationsPreference(enabled: boolean): void {
  try { window.localStorage.setItem(CELEBRATION_STORAGE_KEY, String(enabled)); } catch { /* Optional preference. */ }
  window.dispatchEvent(new CustomEvent(CELEBRATION_EVENT, { detail: enabled }));
}

export function useCelebrationsPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(readCelebrationsPreference());
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setEnabled(typeof detail === "boolean" ? detail : readCelebrationsPreference());
    };
    window.addEventListener(CELEBRATION_EVENT, onChange);
    return () => window.removeEventListener(CELEBRATION_EVENT, onChange);
  }, []);
  return [enabled, useCallback((next: boolean) => { setEnabled(next); writeCelebrationsPreference(next); }, [])];
}

export function CelebrationOverlay({ celebration, messageId, enabled }: { celebration?: Celebration; messageId: string; enabled: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const [active, setActive] = useState(false);
  const seenId = useRef<string | null>(null);
  useEffect(() => {
    if (!celebration?.id || celebration.messageId !== messageId || celebration.id === seenId.current) return;
    seenId.current = celebration.id;
    if (!enabled) return;
    setActive(true);
    const timeout = window.setTimeout(() => setActive(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [celebration, enabled, messageId]);
  if (!active) return null;
  if (reducedMotion) {
    return <span className="message-celebration message-celebration-static" role="status">{celebration?.effect === "confetti" ? "Celebration" : "Nice work"}</span>;
  }
  return (
    <span className={`message-celebration message-celebration-${celebration?.effect ?? "sparkles"}`} aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => <i key={index} style={{ "--celebration-index": index } as CSSProperties} />)}
    </span>
  );
}

export interface MessageReactionsProps {
  threadId?: string;
  messageId?: string;
  disabled?: boolean;
  /** Render the React trigger with action controls instead of a standalone add button. */
  compact?: boolean;
  /** Keep existing pills without rendering an add affordance. */
  showTrigger?: boolean;
  onSelected?: () => void;
  readOnly?: boolean;
}

export function MessageReactions({ threadId, messageId, disabled = false, compact = false, showTrigger = true, onSelected, readOnly = false }: MessageReactionsProps) {
  const state = useThreadExpression(threadId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [typedEmoji, setTypedEmoji] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [celebrationsEnabled] = useCelebrationsPreference();
  const reactions = useMemo(() => messageId ? (state.reactions[messageId] ?? []) : [], [messageId, state.reactions]);

  const sendReaction = async (emoji: string) => {
    if (!isValidReactionEmoji(emoji) || pendingRef.current || !threadId || !messageId) return;
    pendingRef.current = true;
    setPending(emoji); setFailed(false);
    try {
      const snapshot = await postAction(threadId, { action: "react", messageId, emoji });
      const store = ensureStore(threadId);
      onSelected?.();
      if (snapshot) applySnapshot(store, snapshot);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const submitTypedEmoji = () => {
    const emoji = typedEmoji.trim();
    if (!isValidReactionEmoji(emoji)) return;
    setTypedEmoji("");
    setPickerOpen(false);
    void sendReaction(emoji);
  };

  const celebrate = async () => {
    if (pendingRef.current || !celebrationsEnabled || !threadId || !messageId) return;
    pendingRef.current = true;
    setPending("celebrate"); setFailed(false);
    try {
      const snapshot = await postAction(threadId, { action: "celebrate", messageId, effect: "sparkles" });
      const store = ensureStore(threadId);
      if (snapshot) applySnapshot(store, snapshot);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  if (!threadId || !messageId || disabled || (!showTrigger && reactions.length === 0)) return null;

  return (
    <div className={`message-reactions${compact ? " message-reactions-compact" : ""}`}>
      <div className="message-reaction-list" aria-label="Message reactions">
        {(compact ? [] : reactions).map((reaction, index) => {
          const count = reactions.filter(item => item.emoji === reaction.emoji).length;
          const first = reactions.findIndex(item => item.emoji === reaction.emoji) === index;
          if (!first) return null;
          const mine = reactions.some(item => item.emoji === reaction.emoji && item.actor === "user");
          return (
            <button key={reaction.emoji} type="button" className={`message-reaction-pill${mine ? " is-mine" : ""}`} disabled={pendingRef.current} aria-pressed={mine} onClick={readOnly ? undefined : () => void sendReaction(reaction.emoji)}>
              <span aria-hidden="true">{reaction.emoji}</span><span>{count}</span>
            </button>
          );
        })}
        {showTrigger && (
          <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
            <Popover.Trigger className="message-reaction-action" disabled={pendingRef.current} aria-label="React" title="React">
              {pending && pending !== "celebrate" ? <LoaderCircle size={13} className="message-reaction-spinner" aria-hidden="true" /> : <SmilePlus size={13} aria-hidden="true" />}
              <span>React</span>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={8} collisionPadding={12} className="message-reaction-positioner">
                <Popover.Popup className="message-reaction-picker" aria-label="Choose an emoji">
                  {celebrationsEnabled && (
                    <button type="button" className="message-celebrate-menu-action" disabled={pendingRef.current} onClick={() => { setPickerOpen(false); void celebrate(); }}>
                      {pending === "celebrate" ? <LoaderCircle size={13} className="message-reaction-spinner" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
                      <span>Celebrate this message</span>
                    </button>
                  )}
                  <div className="message-reaction-keyboard-entry">
                    <input
                      type="text"
                      value={typedEmoji}
                      maxLength={16}
                      inputMode="text"
                      aria-label="Type an emoji reaction"
                      placeholder="Type an emoji"
                      onChange={(event) => setTypedEmoji(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitTypedEmoji(); } }}
                    />
                    <button type="button" disabled={!isValidReactionEmoji(typedEmoji.trim()) || pendingRef.current} onClick={submitTypedEmoji}>Add</button>
                  </div>
                  {!searchOpen && <><div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", padding: 8, background: "var(--bg-panel)" }}>{COMMON_REACTIONS.slice(0, 24).map(emoji => <button type="button" key={emoji} aria-label={`React ${emoji}`} onClick={() => { setPickerOpen(false); void sendReaction(emoji); }} style={{ height: 34, border: 0, background: "transparent", fontSize: 22 }}>{emoji}</button>)}</div><button type="button" onClick={() => setSearchOpen(true)} style={{ width: "100%", padding: 8, border: 0, background: "var(--bg-panel)", color: "var(--text-muted)" }}>Search more emoji</button></>}
                  {searchOpen &&
                  <EmojiPicker
                    onEmojiClick={(emoji: EmojiClickData) => { setPickerOpen(false); void sendReaction(emoji.emoji); }}
                    theme={typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? Theme.DARK : Theme.LIGHT}
                    emojiStyle={EmojiStyle.NATIVE}
                    lazyLoadEmojis
                    skinTonesDisabled={false}
                    previewConfig={{ showPreview: false }}
                    searchDisabled={false}
                    width={300}
                    height={320}
                  />
                  }
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
        {failed && <span className="message-reaction-error" role="status">Couldn’t save</span>}
      </div>
      <CelebrationOverlay celebration={state.celebration} messageId={messageId} enabled={celebrationsEnabled} />
    </div>
  );
}
