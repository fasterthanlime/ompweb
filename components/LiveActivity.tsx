"use client";

import type { AgentMessage, AssistantMessage, ThinkingContent } from "@/lib/types";
import { useThreadExpression } from "./MessageReactions";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import styles from "./LiveActivity.module.css";

const MAX_THOUGHT_LENGTH = 180;

function isThinkingContent(block: unknown): block is ThinkingContent {
  if (!block || typeof block !== "object") return false;
  const candidate = block as { type?: unknown; thinking?: unknown };
  return candidate.type === "thinking" && typeof candidate.thinking === "string";
}

/**
 * Returns a short, plain-text tail from the latest thinking block. Keeping the
 * tail local to the currently streaming message prevents the activity row from
 * repeating the complete reasoning transcript below it.
 */
export function getLatestThinkingText(message: AgentMessage | null | undefined): string | null {
  if (!message || message.role !== "assistant") return null;
  const blocks = (message as AssistantMessage).content;
  if (!Array.isArray(blocks)) return null;

  const thinking = blocks.filter(isThinkingContent).at(-1)?.thinking.trim();
  if (!thinking) return null;

  const paragraphs = thinking.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const latestParagraph = paragraphs.at(-1) ?? thinking;
  const lines = latestParagraph.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const latestLine = lines.at(-1) ?? latestParagraph;
  const normalized = latestLine.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= MAX_THOUGHT_LENGTH) return normalized;
  return `…${normalized.slice(-(MAX_THOUGHT_LENGTH - 1))}`;
}

export interface LiveActivityProps {
  /** Session id used by the local and remote expression subscription. */
  threadId?: string;
  /** Whether the associated agent is still producing work. */
  busy: boolean;
  /** Current streaming assistant message, when available. */
  message?: AgentMessage | null;
}

export function LiveActivity({ threadId, busy, message }: LiveActivityProps) {
  const { expression } = useThreadExpression(threadId);
  const reducedMotion = usePrefersReducedMotion();


  const thought = getLatestThinkingText(message);
  const cleanExpression = expression.trim();
  const label = busy ? thought ?? "Working" : "Idle";

  return (
    <div className={styles.activity} role="status" aria-live="polite" aria-label={`Agent activity: ${label}`}>
      {cleanExpression && (
        <span className={styles.expression} aria-hidden="true" style={reducedMotion || !busy ? { animation: "none" } : undefined}>
          {cleanExpression}
        </span>
      )}
      <span className={styles.thought}>{label}</span>
    </div>
  );
}
