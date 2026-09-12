import {
  getRemoteSession,
  RemoteSessionError,
  subscribeRemoteSession,
  type RemoteStreamMessage,
} from "@/lib/remote-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function frame(message: RemoteStreamMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Validate before creating a stream, so unknown ids get a normal JSON-like
    // error status rather than an SSE connection that closes immediately.
    getRemoteSession(id);
  } catch (error) {
    const message = error instanceof RemoteSessionError ? error.message : "Remote session not found";
    const status = error instanceof RemoteSessionError ? error.status : 404;
    return new Response(JSON.stringify({ error: message, code: error instanceof RemoteSessionError ? error.code : "remote_session_not_found" }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
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
        unsubscribe();
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      };
      unsubscribe = subscribeRemoteSession(id, (message) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(frame(message))); } catch { close(); }
      });
      heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { close(); } }, 15000);
      if (request.signal.aborted) close();
      request.signal.addEventListener("abort", close, { once: true });
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
