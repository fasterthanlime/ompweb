import { NextResponse } from "next/server";

/**
 * Same-origin pass-through to nookd, so the room page (and the iOS wrapper,
 * which trusts one origin) reaches the daemon behind the auth proxy.
 * `/api/rooms/<x>` -> `${NOOKD_URL}/rooms/<x>`, query and body intact; SSE
 * streams straight through.
 */
const base = (process.env.NOOKD_URL ?? "http://127.0.0.1:7700").replace(/\/$/, "");

export async function forwardToNookd(request: Request, path: string[]): Promise<Response> {
  const url = new URL(request.url);
  const target = `${base}/rooms${path.map(p => "/" + encodeURIComponent(p)).join("")}${url.search}`;
  const headers = new Headers();
  for (const name of ["content-type", "accept", "last-event-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      // @ts-expect-error -- Node fetch needs this to stream a request body.
      duplex: "half",
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "nookd is not reachable" }, { status: 502 });
  }
  const out = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (out.get("content-type")?.startsWith("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

