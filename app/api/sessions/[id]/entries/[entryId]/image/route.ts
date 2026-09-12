import { NextResponse } from "next/server";
import { getSessionEntries } from "@/lib/session-reader";
import { resolveBlobRefsInEntries } from "@/lib/omp/session-files";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { isRecord } from "@/lib/type-guards";
import type { SessionEntry } from "@/lib/types";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  const rawIndex = new URL(request.url).searchParams.get("blockIndex");
  const index = rawIndex === null ? NaN : Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0) return NextResponse.json({ error: "Invalid image index" }, { status: 400 });
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const entry = getSessionEntries(resolved.filePath).find(candidate => candidate.id === entryId);
    if (!entry || entry.type !== "message" || !isRecord(entry.message) || !Array.isArray(entry.message.content)) return new Response(null, { status: 404 });
    const block = entry.message.content[index];
    if (!isRecord(block) || block.type !== "image") return new Response(null, { status: 404 });
    const selected = structuredClone({ ...entry, message: { ...entry.message, content: [block] } });
    resolveBlobRefsInEntries([selected as SessionEntry]);
    const image = selected.message.content[0];
    const source = isRecord(image.source) ? image.source : undefined;
    const data = typeof image.data === "string" ? image.data : source?.type === "base64" && typeof source.data === "string" ? source.data : undefined;
    const mime = typeof image.mimeType === "string" ? image.mimeType : source?.media_type;
    if (!data || typeof mime !== "string" || !/^image\/(png|jpeg|webp|gif|avif)$/.test(mime) || data.startsWith("blob:")) return new Response(null, { status: 404 });
    if (data.length > 32 * 1024 * 1024) return new Response(null, { status: 413 });
    return new Response(Buffer.from(data, "base64"), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return apiErrorResponse(error); }
}
