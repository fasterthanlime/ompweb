import type { AssistantMessage, ToolResultMessage, UserMessage } from "@/lib/types";
import type { RoomEntry } from "@/hooks/useRoom";

/**
 * nookd room entries -> what MessageView already renders. Per entry, not
 * per session: a `message` is one message, a `tool_call` is one assistant
 * message holding one tool call, a `tool_result` pairs with it by id. The
 * room's own kinds (signal, teach, error) stay as they are; the view
 * renders those itself.
 */

export const MARK = "🪧🦊";

/** Assistant text with its signal lines removed; they render as their own rows. */
export function prose(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .filter(line => {
      const s = line.trim();
      if (s.startsWith("```")) fence = !fence;
      return fence || !s.startsWith(MARK);
    })
    .join("\n")
    .trim();
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface RoomRow {
  entry: RoomEntry;
  /** Set for message and tool_call entries. */
  message?: UserMessage | AssistantMessage;
}

export interface RoomModel {
  rows: RoomRow[];
  /** The model's latest expression. */
  expression: { kaomoji: string; caption: string } | null;
  /** Asks with no human message after them: the questions still floating. */
  openAsks: RoomEntry[];
  /** tool_result entries keyed by call id, in MessageView's shape. */
  toolResults: Map<string, ToolResultMessage>;
  /** Latest ack per ref. */
  acks: Map<string, RoomEntry>;
  /** Refs acked `surprise` with no later ack/found/ask naming them. */
  open: Set<string>;
  /** Ref of each tool result keyed by call id, so the block can show its ack. */
  refByCall: Map<string, string>;
}

export function modelRoom(entries: RoomEntry[]): RoomModel {
  const rows: RoomRow[] = [];
  const toolResults = new Map<string, ToolResultMessage>();
  const acks = new Map<string, RoomEntry>();
  const open = new Set<string>();
  const refByCall = new Map<string, string>();
  let expression: { kaomoji: string; caption: string } | null = null;
  let openAsks: RoomEntry[] = [];
  for (const e of entries) {
    const b = e.body;
    const ts = Date.parse(e.created_at);
    switch (e.kind) {
      case "expression":
        expression = { kaomoji: str(b.kaomoji), caption: str(b.caption) };
        break;
      case "message": {
        if (b.role === "user") {
          if (e.author !== "nook") openAsks = [];
          rows.push({ entry: e, message: { role: "user", content: str(b.text), timestamp: ts } });
        } else {
          const text = prose(str(b.text));
          if (text) rows.push({ entry: e, message: { role: "assistant", content: [{ type: "text", text }], model: e.author, provider: "nookd", timestamp: ts } });
        }
        break;
      }
      case "tool_call":
        // Room-state tools have their own surfaces (the graph, the header);
        // the call itself is not worth a line.
        if (b.name === "nodes" || b.name === "expression") break;
        rows.push({
          entry: e,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId: str(b.id), toolName: str(b.name), input: (b.arguments as Record<string, unknown>) ?? {} }],
            model: e.author,
            provider: "nookd",
            timestamp: ts,
          },
        });
        break;
      case "tool_result": {
        const id = str(b.id);
        toolResults.set(id, { role: "toolResult", toolCallId: id, toolName: str(b.name), content: [{ type: "text", text: str(b.output) }], isError: b.failed === true, timestamp: ts });
        if (str(b.ref)) refByCall.set(id, str(b.ref));
        break;
      }
      case "signal": {
        const ref = str(b.ref);
        const signal = str(b.signal);
        if (ref && signal === "ack") {
          acks.set(ref, e);
          if (b.verdict === "surprise") open.add(ref);
          else open.delete(ref);
        } else if (ref && (signal === "found" || signal === "ask")) {
          open.delete(ref);
        }
        if (signal === "ask") openAsks.push(e);
        if (signal !== "ack" && signal !== "status") rows.push({ entry: e });
        break;
      }
      case "teach":
      case "error":
        rows.push({ entry: e });
        break;
      default:
        break;
    }
  }
  // The ack rides on the result's details, so the tool block's meta line
  // shows "r7 · surprise exit 127" without MessageView knowing about rooms.
  for (const [id, ref] of refByCall) {
    const result = toolResults.get(id);
    if (!result) continue;
    const ack = acks.get(ref);
    result.details = { ref, ack: ack ? { verdict: ack.body.verdict, text: ack.body.text } : undefined, open: open.has(ref) };
  }
  return { rows, toolResults, acks, open, refByCall, expression, openAsks };
}
