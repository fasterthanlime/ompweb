import type { AgentMessage } from "./types";

export function activityThoughtSummary(text: string): string {
  let heading: string | undefined;
  for (const match of text.matchAll(/\*\*([^\n]+?)\*\*/g)) heading = match[1];
  const line = heading ?? text.trim().split(/\n/).filter(line => line.trim()).at(-1) ?? text;
  return line.replace(/^\*\*|\*\*$/g, "").replace(/\s+/g, " ").trim();
}
/** Scan only the current user turn; tool results must not erase its latest thought. */
export function latestActivityThought(messages: readonly AgentMessage[], streaming?: AgentMessage | null): string | null {
  function fromMessage(message: AgentMessage): string | null {
    if (message.role !== "assistant") return null;
    for (let i = message.content.length - 1; i >= 0; i--) {
      const block = message.content[i];
      if (block.type !== "thinking") continue;
      const text = (block.thinking || block.summary || "").trim();
      if (!text) continue;
      return activityThoughtSummary(text);
    }
    return null;
  }
  if (streaming) {
    const thought = fromMessage(streaming);
    if (thought) return thought;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") break;
    const thought = fromMessage(messages[i]);
    if (thought) return thought;
  }
  return null;
}
