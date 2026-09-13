"use client";

import type { AgentMessage } from "@/lib/types";
import { latestActivityThought } from "@/lib/live-activity";
import { useThreadExpression } from "./MessageReactions";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import styles from "./LiveActivity.module.css";

export interface LiveActivityProps {
  threadId?: string;
  busy: boolean;
  messages: readonly AgentMessage[];
  message?: AgentMessage | null;
}

export function LiveActivity({ threadId, busy, messages, message }: LiveActivityProps) {
  const { expression } = useThreadExpression(threadId);
  const reducedMotion = usePrefersReducedMotion();
  const label = busy ? latestActivityThought(messages, message) ?? "Working" : "Idle";

  return (
    <div className={styles.activity} role="status" aria-live="polite" aria-label={`Agent activity: ${label}`}>
      {expression.trim() && (
        <span className={styles.expression} aria-hidden="true" style={reducedMotion || !busy ? { animation: "none" } : undefined}>{expression}</span>
      )}
      <span className={styles.thought} title={label}>{label}</span>
    </div>
  );
}
