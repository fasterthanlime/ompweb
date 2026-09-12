import type { RpcProcess } from "./omp/rpc-process";
import { RpcCommandError } from "./omp/rpc-process";
export interface RemotePageCursor { version: 1; sessionId: string; leafId: string | null; messageCount: number; offset: number }
export function decodePageCursor(value: unknown): RemotePageCursor | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor.version !== 1 || typeof cursor.sessionId !== "string" || !cursor.sessionId || !(cursor.leafId === null || typeof cursor.leafId === "string") || !Number.isSafeInteger(cursor.messageCount) || cursor.messageCount < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > cursor.messageCount) return;
    return cursor;
  } catch { return; }
}
export function isPagingConflict(error: unknown): boolean {
  return error instanceof RpcCommandError && error.command === "get_messages_page" && (error.code === "session_busy" || error.code === "stale_cursor");
}
/** Read one bounded range against one native snapshot. Short byte-limited pages
 * advance by their cursor, never by the requested count. Restart a stale
 * transaction once; never combine entries from two native snapshots. */
export async function readRemotePageRange(proc: Pick<RpcProcess, "sendCommand">, before?: number, limit = 100) {
  for (let attempt = 0; ; attempt++) {
    try {
      const probe = await proc.sendCommand<{ messages: unknown[]; totalMessages: number; nextCursor?: string }>({ type: "get_messages_page", limit: 1 });
      if (!Array.isArray(probe.messages) || !Number.isSafeInteger(probe.totalMessages) || probe.totalMessages < 0) throw new Error("Invalid remote page");
      const totalMessages = probe.totalMessages;
      const end = Math.min(before ?? totalMessages, totalMessages);
      const startIndex = Math.max(0, end - limit);
      const seed = decodePageCursor(probe.nextCursor);
      if (totalMessages > 1 && !seed) throw new Error("Remote page cursor unavailable");
      if (!seed) return { messages: probe.messages.slice(startIndex, end), totalMessages, startIndex, seed };
      const messages: unknown[] = [];
      let offset = startIndex;
      while (offset < end) {
        const page = await proc.sendCommand<{ messages: unknown[]; totalMessages: number; nextCursor?: string }>({ type: "get_messages_page", cursor: Buffer.from(JSON.stringify({ ...seed, offset })).toString("base64url"), limit: end - offset });
        if (page.totalMessages !== totalMessages || !Array.isArray(page.messages) || page.messages.length === 0 || page.messages.length > end - offset) throw new Error("Invalid remote page progression");
        const nextOffset = offset + page.messages.length;
        const next = decodePageCursor(page.nextCursor);
        if (nextOffset < totalMessages && (!next || next.offset !== nextOffset || next.sessionId !== seed.sessionId || next.leafId !== seed.leafId || next.messageCount !== totalMessages)) throw new Error("Invalid remote page cursor progression");
        messages.push(...page.messages);
        offset = nextOffset;
      }
      return { messages, totalMessages, startIndex, seed };
    } catch (error) {
      if (attempt === 0 && error instanceof RpcCommandError && error.code === "stale_cursor") continue;
      throw error;
    }
  }
}
