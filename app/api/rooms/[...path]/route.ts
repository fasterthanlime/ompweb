import { forwardToNookd } from "@/lib/nookd-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forwardToNookd(request, (await ctx.params).path);
}
export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forwardToNookd(request, (await ctx.params).path);
}
