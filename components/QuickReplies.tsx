"use client";
import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

const QUICK_REPLIES = [
  { label: "Onwards", message: "Keep going" },
  { label: "Do it", message: "Do it." },
  { label: "Push", message: "Commit and push." },
  { label: "Deploy", message: "Deploy." },
  { label: "Feel", message: "How do you feel about the current work?" },
  { label: "Resume", message: "Review everything we discussed before the latest detour. Identify the agreed work still unfinished, then pick it back up. Preserve the decisions we made; don’t repeat completed work or treat deferred ideas as approved." },
  { label: "Goal", message: "Set this as your goal." },
] as const;

export function QuickReplies({ onReply }: { onReply: (message: string) => unknown | Promise<unknown> }) {
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
    {QUICK_REPLIES.map(({ label, message }) => (
      <button key={label} className="quick-reply-primary" type="button" disabled={busy} aria-label={label} title={message} onClick={() => void reply(message)}>
        <span>{label}</span>
      </button>
    ))}
    {failed && <span role="alert">Reply not sent. Please try again.</span>}
  </div>;
}
