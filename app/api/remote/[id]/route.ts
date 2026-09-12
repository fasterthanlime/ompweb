import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  archiveRemoteSession,
  abortRemoteSession,
  connectRemoteSession,
  getRemoteSessionPage,
  RemoteSessionError,
  submitRemotePrompt,
  remoteControls,
  readRemoteSubagents,
  forkRemoteSession,
  remoteBranchEntries,
} from "@/lib/remote-sessions";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REMOTE_REQUEST_BYTES = 16 * 1024 * 1024;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RemoteSessionError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Remote session request failed", code: "remote_session_error" }, { status: 500 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const beforeRaw = url.searchParams.get("before");
    const limitRaw = url.searchParams.get("limit");
    const before = beforeRaw === null ? undefined : Number(beforeRaw);
    const limit = limitRaw === null ? 100 : Number(limitRaw);
    return NextResponse.json(await getRemoteSessionPage(id, before, limit));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let body: unknown;
    try {
      body = await parseJsonWithinLimit<unknown>(request, MAX_REMOTE_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Remote request is too large", code: "request_too_large" }, { status: 413 });
      }
      return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const type = record.type;
    if (type === "archive") { await archiveRemoteSession(id); return NextResponse.json({ success: true }); }
    if (type === "connect") return NextResponse.json(await connectRemoteSession(id));
    if (type === "abort") return NextResponse.json({ success: true, data: await abortRemoteSession(id) });
    if (type === "get_controls") return NextResponse.json(await remoteControls(id));
    if (type === "get_subagents") return NextResponse.json(await readRemoteSubagents(id));
    if (type === "get_subagent_messages" && typeof record.subagentId === "string" && (record.fromByte === undefined || typeof record.fromByte === "number")) return NextResponse.json(await readRemoteSubagents(id, record.subagentId, record.fromByte as number | undefined));
    if (type === "get_branch_messages") return NextResponse.json(await remoteBranchEntries(id));
    if (type === "fork" && typeof record.entryId === "string") return NextResponse.json(await forkRemoteSession(id, record.entryId));
    if (type === "set_model" && typeof record.provider === "string" && typeof record.modelId === "string") return NextResponse.json(await remoteControls(id, {type,provider:record.provider,modelId:record.modelId}));
    if (type === "set_thinking_level" && typeof record.level === "string") return NextResponse.json(await remoteControls(id, {type,level:record.level}));
    if (type === "set_session_name" && typeof record.name === "string" && record.name.trim() && record.name.length <= 200) return NextResponse.json(await remoteControls(id, {type,name:record.name.trim()}));
    if (type === "compact" && (record.customInstructions === undefined || typeof record.customInstructions === "string")) return NextResponse.json(await remoteControls(id, { type, customInstructions: record.customInstructions as string | undefined }));
    if (type === "abort_compaction") return NextResponse.json(await remoteControls(id, { type }));
    if (type === "set_goal" && ["start", "pause", "resume", "clear"].includes(String(record.action))) return NextResponse.json(await remoteControls(id, { type, action: record.action as "start" | "pause" | "resume" | "clear", objective: typeof record.objective === "string" ? record.objective : undefined }));
    if (type === "prompt" || type === "submit") {
      if (typeof record.message !== "string") {
        return NextResponse.json({ error: "message is required", code: "message_required" }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        data: await submitRemotePrompt(id, record.message, record.images),
      });
    }
    return NextResponse.json({ error: "type must be prompt, abort, or connect", code: "invalid_command_type" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
