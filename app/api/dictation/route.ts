import { NextRequest, NextResponse } from "next/server";
import { parseBytesWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  DictationAbortedError,
  DictationCredentialError,
  DictationProviderError,
  DictationRateLimitError,
  DictationTimeoutError,
  transcribeAudio,
} from "@/lib/google-dictation";

export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
// Browser MediaRecorder output variants across Chrome/Firefox/Safari, plus
// plain WAV uploads. Parameters after ";" are dropped before matching.
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
]);

function normalizeMimeType(contentType: string | null): string | null {
  const base = contentType?.split(";")[0]?.trim().toLowerCase();
  return base || null;
}

export async function POST(request: NextRequest) {
  const mimeType = normalizeMimeType(request.headers.get("content-type"));
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported audio format" }, { status: 415 });
  }

  let audio: Uint8Array;
  try {
    audio = await parseBytesWithinLimit(request, MAX_AUDIO_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Audio body is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "Unable to read audio body" }, { status: 400 });
  }
  if (audio.byteLength === 0) {
    return NextResponse.json({ error: "Audio body is empty" }, { status: 400 });
  }

  try {
    const text = await transcribeAudio({ data: audio, mimeType }, { signal: request.signal });
    return NextResponse.json({ text });
  } catch (error) {
    if (error instanceof DictationCredentialError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof DictationAbortedError) {
      return NextResponse.json({ error: "Dictation canceled" }, { status: 400 });
    }
    if (error instanceof DictationTimeoutError) {
      return NextResponse.json({ error: "Dictation timed out" }, { status: 504 });
    }
    if (error instanceof DictationRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof DictationProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("Dictation error:", error);
    return NextResponse.json({ error: "Dictation failed" }, { status: 500 });
  }
}