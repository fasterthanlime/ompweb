import {
  getThreadExpression,
  subscribeThreadExpression,
} from "@/lib/thread-expression";
import { isRemoteSession, RemoteSessionError } from "@/lib/remote-sessions";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown): Response {
  const status = error instanceof RemoteSessionError ? error.status : 404;
  const code = error instanceof RemoteSessionError ? error.code : "session_not_found";
  const message = error instanceof Error ? error.message : "Session not found";
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    if (!isRemoteSession(id) && !(await resolveSessionPath(id))) return errorResponse(new Error("Session not found"));
    getThreadExpression(id);
  } catch (error) {
    return errorResponse(error);
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch {}
      };
      unsubscribe = subscribeThreadExpression(id, (state) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`)); } catch { close(); }
      });
      request.signal.addEventListener("abort", close, { once: true });
      heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { close(); } } }, 15000);
      if (request.signal.aborted) close();
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribe = () => {};
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
