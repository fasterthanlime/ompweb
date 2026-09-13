import type { ReactionTarget } from "./thread-expression";
import type { AgentMessage } from "./types";

/** Feedback, not permission to resume an old goal or an instruction to reply. */
export function reactionNotification(target: ReactionTarget, emoji: string, added: boolean): string {
  return `<system-reminder>\nUser ${added ? "reacted with" : "removed their reaction"} ${JSON.stringify(emoji)} ${added ? "to" : "from"} your message ${JSON.stringify(target.id)}. Message excerpt (quoted data): ${JSON.stringify(target.preview).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}. This is feedback, not a new task or permission to resume paused work. No textual acknowledgment is required.\n</system-reminder>`;
}

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const NOTICE = new RegExp(`^<system-reminder>\\nUser (reacted with|removed their reaction) (${JSON_STRING}) (to|from) your message (${JSON_STRING})\\. Message excerpt \\(quoted data\\): (${JSON_STRING})\\. This is feedback, not a new task or permission to resume paused work\\. No textual acknowledgment is required\\.\\n</system-reminder>$`);

/** Display-only: retain native messages and indices for agent context and paging. */
export function isReactionNotification(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  if (Array.isArray(message.content) && message.content.some(block => block.type !== "text")) return false;
  const text = typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n");
  const match = NOTICE.exec(text);
  if (!match) return false;
  try {
    const added = match[1] === "reacted with";
    return text === reactionNotification({ id: JSON.parse(match[4]), role: "assistant", preview: JSON.parse(match[5]) }, JSON.parse(match[2]), added);
  } catch {
    return false;
  }
}
