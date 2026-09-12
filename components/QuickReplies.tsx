"use client";
import { useRef, useState } from "react";
import { FastForward, GitCommitHorizontal, ListChecks, Target, Play, Heart } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const QUICK_REPLIES = [
  { label: "Keep going", message: "Keep going", icon: FastForward },
  { label: "Do it", message: "Do it", icon: Play },
  { label: "Feel?", message: "How do you feel about the current work?", icon: Heart },
  { label: "Set goal", message: "Set this as your goal", icon: Target },
  { label: "Commit & push", message: "Commit & push", icon: GitCommitHorizontal },
  { label: "Next unit of work", message: "Next unit of work please", icon: ListChecks },
] as const;

export function QuickReplies({ onReply, onStartTyping }: { onReply: (message: string) => unknown | Promise<unknown>; onStartTyping: () => void }) {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reply = async (message: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { if (await onReply(message) === false) setFailed(true); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="answer-quick-replies composer-quick-replies" aria-label={t("chatInput.quickReplies")}>
    <button className="composer-type-prompt" type="button" onClick={onStartTyping}>Type here…</button>
    {QUICK_REPLIES.map(({ label, message, icon: Icon }) => (
      <button key={label} className="quick-reply-primary" type="button" disabled={busy} aria-label={label} title={message} onClick={() => void reply(message)}>
        <Icon size={15} aria-hidden="true" /><span>{label}</span>
      </button>
    ))}
    <button className="quick-reply-primary" type="button" disabled={busy} aria-label={t("chatInput.quickThumbsUp")} title={t("chatInput.quickThumbsUp")} onClick={()=>void reply("👍")}><span aria-hidden="true">👍</span></button>
    {failed && <span role="alert">Reply not sent. Please try again.</span>}
  </div>;
}
