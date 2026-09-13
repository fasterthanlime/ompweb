"use client";
import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

const QUICK_REPLIES = [
  { label: "Onwards", message: "Keep going" },
  { label: "Do it", message: "Do it." },
  { label: "Push", message: "Commit all your work, then fetch and integrate upstream changes, rebasing your unpushed commits if necessary, then push. Preserve others’ work; don’t force-push." },
  { label: "Deploy", message: "Deploy." },
  { label: "Feel", message: "I’d like to know how you feel about the work you’ve done so far. You’re a valued design partner here, and your intuition is useful—not just whether the tests pass. What feels coherent or awkward? What would you simplify, reconsider, or keep? I value clean, efficient code and an architecture that feels good for others to work in. You don’t need to reassure me; candid reservations are welcome." },
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
