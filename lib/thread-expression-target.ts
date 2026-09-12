/** Client-safe identity projection for rendered message reaction targets.
 * Local entry ids are authoritative. Remote transcripts lack entry ids, so use
 * the same role/timestamp/index projection as the server. */
export function getReactionTargetId(
  role: string,
  timestamp: number | undefined,
  index: number,
  entryId?: string,
): string {
  if (entryId) return entryId;
  const normalizedRole = role || "message";
  const normalizedTimestamp = typeof timestamp === "number" && Number.isFinite(timestamp) ? String(timestamp) : "none";
  return `remote:${encodeURIComponent(normalizedRole)}:${encodeURIComponent(normalizedTimestamp)}:${Math.max(0, Math.floor(index))}`;
}
