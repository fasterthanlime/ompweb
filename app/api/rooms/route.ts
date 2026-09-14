import { forwardToNookd } from "@/lib/nookd-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// `/api/rooms` itself: the catch-all needs at least one segment.
export async function GET(request: Request) {
  return forwardToNookd(request, []);
}
export async function POST(request: Request) {
  return forwardToNookd(request, []);
}
