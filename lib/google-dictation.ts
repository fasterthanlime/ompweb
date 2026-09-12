import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";

/** Shared Gemini key used by the omp Discord agent, so both surfaces reuse
 * the same Google credential. */
export const DEFAULT_GEMINI_API_KEY_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "discord-gemini-api-key",
);

/** Env override for the credential file location, e.g. for testing or
 * per-deployment key rotation. */
export function dictationApiKeyPath(): string {
  const override = process.env.OMP_WEB_GEMINI_API_KEY_PATH?.trim();
  return override || DEFAULT_GEMINI_API_KEY_PATH;
}

/** Typed failures the route maps to HTTP status codes; messages are safe to
 * surface (they never contain the API key). */
export class DictationCredentialError extends Error {}
export class DictationAbortedError extends Error {}
export class DictationTimeoutError extends Error {}
export class DictationRateLimitError extends Error {}
export class DictationProviderError extends Error {}

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
/** End-to-end deadline for provider work. The SDK upload helper does not
 * forward AbortSignal, so the deadline is enforced by racing the upload (and
 * the interaction) against this timer; each underlying HTTP request is
 * additionally bounded by the client timeout. */
const DICTATION_TIMEOUT_MS = 60_000;
/** Cleanup must never hang the response, and must not reuse the aborted
 * signal — the file delete runs with its own single-attempt timeout. */
const DELETE_TIMEOUT_MS = 15_000;

export interface DictationAudio {
  data: Uint8Array;
  mimeType: string;
}

export interface DictationOptions {
  /** Cancels transcription; an in-flight SDK upload finishes before cleanup. */
  signal?: AbortSignal;
  /** Credential file path; defaults to OMP_WEB_GEMINI_API_KEY_PATH or the
   * shared Discord key at ~/.omp/agent/discord-gemini-api-key. */
  keyPath?: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Read the Gemini API key from disk, enforcing a regular file with mode
 * 0600. Returns undefined when no key is configured. */
export async function readGeminiApiKey(
  keyPath = dictationApiKeyPath(),
): Promise<string | undefined> {
  try {
    const metadata = await stat(keyPath);
    if (!metadata.isFile()) {
      throw new DictationCredentialError("Dictation credential path is not a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new DictationCredentialError("Dictation credential file must use mode 0600");
    }
    const apiKey = (await readFile(keyPath, "utf8")).trim();
    return apiKey || undefined;
  } catch (error) {
    if (error instanceof DictationCredentialError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new DictationCredentialError("Unable to read dictation credentials");
  }
}

/** Race `promise` against the dictation deadline and the caller's cancel
 * signal. The SDK upload helper ignores AbortSignal, so this race — not the
 * underlying requests — is what keeps the end-to-end deadline from hanging the
 * caller, and what turns a client abort into a prompt rejection. When the race
 * is lost but the work later settles, `onLateSettle` receives the result so
 * best-effort cleanup can still run (e.g. deleting a file whose upload only
 * completed after the deadline fired). A late rejection is consumed by the
 * handler attached here, so it can never surface as an unhandled rejection.
 *
 * @internal Exported for the regression test; not part of the public API.
 */
export function raceWithDeadline<T>(
  promise: Promise<T>,
  clientSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  onLateSettle?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        clientSignal?.aborted
          ? new DictationAbortedError()
          : new DictationTimeoutError(),
      );
    };
    const cleanup = () => {
      timeoutSignal.removeEventListener("abort", onAbort);
      clientSignal?.removeEventListener("abort", onAbort);
    };
    promise.then(
      (value) => {
        if (settled) {
          onLateSettle?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    timeoutSignal.addEventListener("abort", onAbort);
    clientSignal?.addEventListener("abort", onAbort);
    if (clientSignal?.aborted || timeoutSignal.aborted) onAbort();
  });
}

/** Best-effort deletion of an uploaded audio file, detached from the response
 * path: never awaited by the caller, bounded to a single DELETE_TIMEOUT_MS
 * attempt, and failures consumed so no unhandled rejection can escape. */
function cleanupUploadedFile(client: GoogleGenAI, name: string): void {
  void client.files
    .delete({
      name,
      config: {
        httpOptions: {
          timeout: DELETE_TIMEOUT_MS,
          // attempts 0/1 disables the SDK's retry loop, keeping the delete
          // bounded end-to-end rather than per-attempt.
          retryOptions: { attempts: 1 },
        },
      },
    })
    .catch(() => undefined);
}

/** Transcribe an audio blob through Gemini (gemini-3.5-transcribe, smart
 * mode). Uploads the audio, runs the interaction without storing it, and
 * attempts to delete the uploaded file afterward. The transcript is returned
 * without waiting for the deletion; an upload that only settles after the
 * deadline is still deleted best-effort once it resolves. */
export async function transcribeAudio(
  audio: DictationAudio,
  options: DictationOptions = {},
): Promise<string> {
  const apiKey = await readGeminiApiKey(options.keyPath);
  if (!apiKey) throw new DictationCredentialError("Dictation is not configured");
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: DICTATION_TIMEOUT_MS } });

  const timeoutSignal = AbortSignal.timeout(DICTATION_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  let uploadedName: string | undefined;
  try {
    signal.throwIfAborted();
    // The SDK upload helper does not forward AbortSignal, so timeout/cancel is
    // enforced by racing it; whatever it eventually produces is cleaned up,
    // even when that happens after the deadline already fired.
    const uploadPromise = client.files.upload(
      {
        file: new Blob([audio.data as Uint8Array<ArrayBuffer>], { type: audio.mimeType }),
        config: { mimeType: audio.mimeType },
      },
    );
    const uploaded = await raceWithDeadline(
      uploadPromise,
      options.signal,
      timeoutSignal,
      (lateUpload) => {
        const name = lateUpload?.name;
        if (name) cleanupUploadedFile(client, name);
      },
    );
    uploadedName = uploaded.name;
    if (!uploaded.name || !uploaded.uri) {
      throw new DictationProviderError(
        "Dictation provider did not return an uploaded audio file",
      );
    }

    // A cancel or deadline that fired during the upload must prevent the
    // transcription from ever starting.
    signal.throwIfAborted();
    const interaction = await raceWithDeadline(
      client.interactions.create(
        {
          model: TRANSCRIBE_MODEL,
          input: [{ type: "audio", uri: uploaded.uri, mime_type: audio.mimeType }],
          generation_config: {
            // Interactions uses lowercase values, unlike generateContent's enum.
            transcription_config: {
              mode: "smart",
              custom_vocabulary: ["OMP", "Oh My Pi", "ompweb", "Vixenware", "nexiv"],
            },
          },
          store: false,
        },
        { signal, timeout: DICTATION_TIMEOUT_MS },
      ),
      options.signal,
      timeoutSignal,
    );
    const transcript = interaction.output_text?.trim();
    if (!transcript) {
      throw new DictationProviderError("Dictation provider returned an empty transcript");
    }
    return transcript;
  } catch (error) {
    throw translateDictationError(error, options.signal, timeoutSignal);
  } finally {
    if (uploadedName) cleanupUploadedFile(client, uploadedName);
  }
}

/** Extract the numeric HTTP status an SDK error carries. The provider error
 * surface has two shapes — the legacy `ApiError` (upload path) and the bridge
 * `APIError` family (interactions path) — and both expose `status`; that is
 * all the mapping below relies on. */
function providerStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  // Both SDK error families expose a numeric `status`; validate it at the
  // boundary rather than trusting the shape.
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

/** Map an arbitrary failure from the provider work to a safe, typed error the
 * route can turn into an actionable HTTP status. Never surfaces provider
 * response bodies or the API key; only the numeric status is logged.
 *
 * @internal Exported for the regression test; not part of the public API.
 */
export function translateDictationError(
  error: unknown,
  clientSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): Error {
  // Errors produced by the deadline race or by our own validation pass through
  // untouched.
  if (error instanceof DictationAbortedError) return error;
  if (error instanceof DictationTimeoutError) return error;
  if (error instanceof DictationRateLimitError) return error;
  if (error instanceof DictationProviderError) return error;
  if (error instanceof DictationCredentialError) return error;
  if (clientSignal?.aborted) return new DictationAbortedError();
  if (timeoutSignal.aborted) return new DictationTimeoutError();
  const status = providerStatus(error);
  if (status === 401) {
    // Definitively an invalid/rotated key: tell the operator to check it.
    return new DictationCredentialError(
      "Dictation credential was rejected by the provider",
    );
  }
  if (status === 403) {
    // Permission denial overlaps with quota exhaustion; do not claim a
    // specific cause without evidence.
    return new DictationCredentialError("Dictation provider denied the request");
  }
  if (status === 429) {
    // Provider is rate limiting requests. No claim about quota/credits.
    return new DictationRateLimitError(
      "Dictation provider is rate limiting requests; try again shortly",
    );
  }
  if (status !== undefined) {
    console.error("Dictation provider status:", status);
  } else {
    console.error("Dictation provider request failed");
  }
  return new DictationProviderError("Dictation provider error");
}