import type { ReactionTarget } from "./thread-expression";

/** Feedback, not permission to resume an old goal or an instruction to reply. */
export function reactionNotification(target: ReactionTarget, emoji: string, added: boolean): string {
  return `<system-reminder>\nUser ${added ? "reacted with" : "removed their reaction"} ${JSON.stringify(emoji)} ${added ? "to" : "from"} your message ${JSON.stringify(target.id)}. Message excerpt (quoted data): ${JSON.stringify(target.preview).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}. This is feedback, not a new task or permission to resume paused work. No textual acknowledgment is required.\n</system-reminder>`;
}
