import { stripInteractionReminder } from "./interaction-reminder-text.ts";
import type { AgentMessage, ImageContent, UserMessage } from "./types";

function extractUserText(message: UserMessage): string {
  if (typeof message.content === "string") return stripInteractionReminder(message.content);
  return stripInteractionReminder(message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n"));
}

function imageSignature(block: ImageContent): string {
  if (block.source) {
    return [
      block.source.type === "url" ? "url" : "base64",
      block.source.media_type ?? "",
      block.source.data ?? "",
      block.source.url ?? "",
    ].join(":");
  }
  return ["base64", block.mimeType ?? "", block.data ?? "", ""].join(":");
}

export function userMessageKey(message: UserMessage): string {
  if (typeof message.content === "string") return JSON.stringify({ text: extractUserText(message), images: [] });
  return JSON.stringify({
    text: extractUserText(message),
    images: message.content.filter((block) => block.type === "image").map(imageSignature),
  });
}
export function deliveredUserMessageKey(message: UserMessage): string {
  return JSON.stringify({ content: userMessageKey(message), timestamp: message.timestamp ?? null });
}

/** A terminal session-file read may race writes for both the initial prompt
 * and a queued user delivery that arrived immediately after agent_end. */
export function reconcileTerminalMessages(
  snapshot: AgentMessage[],
  current: AgentMessage[],
  optimisticUserKey: string | null,
  protectedDeliveredKeys: ReadonlySet<string> = new Set(),
): AgentMessage[] {
  const missing: AgentMessage[] = [];
  if (optimisticUserKey && !snapshot.some((message) => message.role === "user" && userMessageKey(message) === optimisticUserKey)) {
    const optimistic = current.findLast((message) => message.role === "user" && userMessageKey(message) === optimisticUserKey);
    if (optimistic) missing.push(optimistic);
  }
  for (const message of current) {
    if (message.role !== "user" || !protectedDeliveredKeys.has(deliveredUserMessageKey(message))) continue;
    if (!snapshot.some((candidate) => candidate.role === "user" && deliveredUserMessageKey(candidate) === deliveredUserMessageKey(message))) {
      missing.push(message);
    }
  }
  return missing.length > 0
    ? [...snapshot, ...missing.filter((message, index) => missing.indexOf(message) === index)]
    : snapshot;
}

function isSameDeliveredUserMessage(left: AgentMessage, right: UserMessage): boolean {
  return left.role === "user" && deliveredUserMessageKey(left) === deliveredUserMessageKey(right);
}

/** User message_end can arrive after agent_end. Append it even though the run
 * is terminal, but do not duplicate a copy already loaded from disk. */
export function appendDeliveredUserMessage(
  messages: AgentMessage[],
  delivered: UserMessage,
  optimisticUserKey: string | null,
): AgentMessage[] {
  const deliveredIndex = messages.findIndex((message) => isSameDeliveredUserMessage(message, delivered));
  const optimisticIndex = optimisticUserKey
    ? messages.findLastIndex((message) => message.role === "user" && userMessageKey(message) === optimisticUserKey)
    : -1;
  if (deliveredIndex >= 0) {
    // A snapshot may already contain the confirmation beside our pending copy.
    return optimisticIndex >= 0 && optimisticIndex !== deliveredIndex
      ? messages.filter((_, index) => index !== optimisticIndex)
      : messages;
  }
  if (optimisticIndex >= 0) {
    return messages.map((message, index) => index === optimisticIndex ? delivered : message);
  }
  return [...messages, delivered];
}
