import { NextResponse } from "next/server";
import { getRealtimeDictationConfig } from "@/lib/dictation-live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/dictation/live — feature flag for the browser; never exposes the
// upstream URL. The live transport itself is the same-origin WebSocket at
// /api/dictation/live/socket, served by the custom Next HTTP server
// (server/omp-web-server.ts), which owns upgrade handling.
export async function GET() {
  const { enabled, supportedDisplayModes } = getRealtimeDictationConfig();
  return NextResponse.json({ enabled, supportedDisplayModes });
}