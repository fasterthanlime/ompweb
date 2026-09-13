import { reactionNotification } from "@/lib/reaction-notification";
import { getRpcSession, startRpcSession, resolveSpawnCwdResult } from "@/lib/rpc-manager";
import { readSessionHeader } from "@/lib/session-reader";
import { getSessionAdvisorEnabled } from "@/lib/session-preferences";
import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import {
  getLocalReactionTargets,
  getThreadExpression,
  updateThreadExpression,
} from "@/lib/thread-expression";
import { getRemoteReactionTargets, isRemoteSession, RemoteSessionError, notifyRemoteReaction } from "@/lib/remote-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 64 * 1024;

type ValidatedThread = { id: string; remote: boolean; filePath?: string };

async function validateThread(id: string): Promise<ValidatedThread | NextResponse> {
  if (isRemoteSession(id)) return { id, remote: true };
  const resolved = await resolveSessionPathOr404(id);
  if ("response" in resolved) return resolved.response;
  return { id, remote: false, filePath: resolved.filePath };
}

async function targetsFor(thread: ValidatedThread) {
  return thread.remote
    ? await getRemoteReactionTargets(thread.id)
    : getLocalReactionTargets(thread.filePath!);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Thread expression request is too large", code: "request_too_large" }, { status: 413 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  if (error instanceof RemoteSessionError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return apiErrorResponse(error);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const thread = await validateThread(id);
    if (thread instanceof NextResponse) return thread;
    return NextResponse.json(getThreadExpression(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const thread = await validateThread(id);
    if (thread instanceof NextResponse) return thread;
    const body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_REQUEST_BYTES);
    const action = body.action;
    if (action === "expression") {
      if (typeof body.expression !== "string" || typeof body.caption !== "string") {
        return NextResponse.json({ error: "expression and caption are required", code: "invalid_expression" }, { status: 400 });
      }
      const state = updateThreadExpression(id, { action, expression: body.expression, caption: body.caption });
      return NextResponse.json(state);
    }
    const targets = await targetsFor(thread);
    if (action === "react") {
      if (typeof body.messageId !== "string" || typeof body.emoji !== "string") {
        return NextResponse.json({ error: "messageId and emoji are required", code: "invalid_reaction" }, { status: 400 });
      }
      const state = updateThreadExpression(id, { action, messageId: body.messageId, emoji: body.emoji, actor: "user" }, targets);
      const target = targets.find(target => target.id === body.messageId);
      if (target?.role === "assistant") {
        const added = state.reactions[body.messageId]?.some(reaction => reaction.actor === "user" && reaction.emoji === body.emoji) ?? false;
        const message = reactionNotification(target, body.emoji, added);
        try {
          if (thread.remote) {
            await notifyRemoteReaction(id, message);
          } else {
            let session = getRpcSession(id);
            if (!session?.isAlive()) {
              const header = readSessionHeader(thread.filePath!);
              const { cwd } = resolveSpawnCwdResult(header?.cwd);
              session = (await startRpcSession(id, thread.filePath!, cwd, undefined, getSessionAdvisorEnabled(id), header?.cwd)).session;
            }
            await session.send({ type: "reaction_notification", message });
          }
        } catch {
          return NextResponse.json({ ...state, notificationError: "Reaction saved, but the agent could not be notified." });
        }
      }
      return NextResponse.json(state);
    }
    if (action === "celebrate") {
      if (typeof body.messageId !== "string" || (body.effect !== "confetti" && body.effect !== "sparkles")) {
        return NextResponse.json({ error: "messageId and a valid effect are required", code: "invalid_celebration" }, { status: 400 });
      }
      const state = updateThreadExpression(id, { action, messageId: body.messageId, effect: body.effect }, targets);
      return NextResponse.json(state);
    }
    return NextResponse.json({ error: "Unknown thread expression action", code: "invalid_action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
