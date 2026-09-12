import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  createRemoteSession,
  listRemoteSessions,
  RemoteSessionError,
} from "@/lib/remote-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RemoteSessionError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Remote session request failed", code: "remote_session_error" }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(listRemoteSessions());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await parseJsonWithinLimit<unknown>(request, MAX_REMOTE_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Remote request is too large", code: "request_too_large" }, { status: 413 });
      }
      return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
    }
    const targetId = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).targetId
      : undefined;
    if (typeof targetId !== "string" || !targetId.trim()) {
      return NextResponse.json({ error: "targetId is required", code: "target_id_required" }, { status: 400 });
    }
    const snapshot = await createRemoteSession(targetId);
    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
