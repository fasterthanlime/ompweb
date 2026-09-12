"use client";

import type { DictationSpan } from "@/lib/dictation-display";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Download, Loader2, Mic, RotateCcw, Square, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { LiveCapture } from "@/lib/dictation-live-capture";
import { detectLiveDictation } from "@/lib/dictation-live-client";

type Phase = "idle" | "permission" | "recording" | "transcribing" | "failed";
type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
type AudioKit = {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
};
type Capture = {
  cancelled: boolean;
  released?: boolean;
  finishing?: boolean;
  transcriptDelivered?: boolean;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  request?: AbortController;
  timer?: TimerHandle;
  interval?: IntervalHandle;
  raf?: number;
  audio?: AudioKit;
  startedAt?: number;
  sendAfterTranscription?: boolean;
  live?: LiveCapture;
  releaseWakeLock?: () => void;
};

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DURATION_MS = 5 * 60 * 1000;
const METER_BARS = 36;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Audio kept after a failed transcription so the user can retry or download it. */
type RetainedAudio = { blob: Blob; mimeType: string; pcm?: Uint8Array<ArrayBuffer>[] };
/** File extension per recorded MIME base type; stays in sync with the server's ALLOWED_MIME_TYPES. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

function keepScreenAwake(capture: Capture) {
  if (!navigator.wakeLock) return;
  let stopped = false;
  let pending = false;
  let lock: WakeLockSentinel | undefined;
  const acquire = async () => {
    if (stopped || pending || (lock && !lock.released) || document.visibilityState !== "visible") return;
    pending = true;
    try {
      const acquired = await navigator.wakeLock.request("screen");
      if (stopped) await acquired.release();
      else lock = acquired;
    } catch {
      // Battery policy or browser support must not prevent recording.
    } finally { pending = false; }
  };
  const onVisible = () => { void acquire(); };
  document.addEventListener("visibilitychange", onVisible);
  capture.releaseWakeLock = () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (lock) void lock.release().catch(() => {});
    lock = undefined;
    capture.releaseWakeLock = undefined;
  };
  void acquire();
}

/** Stop every resource the capture holds: timers, frames, tracks, AudioContext. Idempotent. */
function release(capture: Capture) {
  if (capture.released) return;
  capture.released = true;
  capture.releaseWakeLock?.();
  clearTimeout(capture.timer);
  capture.timer = undefined;
  clearInterval(capture.interval);
  capture.interval = undefined;
  if (capture.raf !== undefined) {
    cancelAnimationFrame(capture.raf);
    capture.raf = undefined;
  }
  capture.stream?.getTracks().forEach((track) => track.stop());
  capture.stream = undefined;
  const audio = capture.audio;
  capture.audio = undefined;
  if (audio) {
    audio.source.disconnect();
    audio.analyser.disconnect();
    if (audio.ctx.state !== "closed") void audio.ctx.close().catch(() => {});
  }
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** POST recorded audio for transcription and return the trimmed text. Throws
 * an Error whose message is safe to surface (the server's own explanation
 * when it provides one, e.g. quota failures). Separate from the recording
 * lifecycle so the initial attempt and a retry share one upload path. */
async function transcribePost(
  blob: Blob,
  mimeType: string,
  signal: AbortSignal,
  failedMessage: string,
): Promise<string> {
  const response = await fetch("/api/dictation", {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: blob,
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : failedMessage);
  }
  if (typeof result?.text !== "string" || !result.text.trim()) {
    throw new Error(failedMessage);
  }
  return result.text.trim();
}

export function DictationControl({
  onTranscript,
  onActiveChange,
  onPreview,
  sendLabel,
}: {
  onTranscript: (text: string, send: boolean) => void;
  onActiveChange?: (active: boolean) => void;
  onPreview?: (text: string, spans?: DictationSpan[]) => void;
  sendLabel: string;
}) {
  const { t } = useI18n();
  const [partial, setPartial] = useState("");
  const [partialSpans, setPartialSpans] = useState<DictationSpan[] | undefined>();
  const liveConfigRef = useRef<Promise<boolean> | null>(null);
  const [provider, setProvider] = useState("Local");
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    const config = detectLiveDictation();
    liveConfigRef.current = config;
    void config.catch(() => {});
  }, []);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [retained, setRetained] = useState<RetainedAudio | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const diagnosticStartRef = useRef(0);
  const diagnosticRef = useRef<object[]>([]);
  const [diagnosticReport, setDiagnosticReport] = useState("");
  const diagnosticDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const recordDiagnostic = (stage: string, capture?: Capture, cause?: unknown) => {
    const entry = {
      stage, elapsedMs: Math.round(performance.now() - diagnosticStartRef.current),
      visibility: document.visibilityState,
      recorder: capture?.recorder?.state,
      transport: capture?.live?.diagnostics(),
      audioContext: capture?.audio?.ctx.state,
      tracks: capture?.stream?.getAudioTracks().map(track => ({ state: track.readyState, muted: track.muted, enabled: track.enabled })),
      errorType: cause instanceof Error ? cause.name : undefined,
    };
    diagnosticRef.current = [...diagnosticRef.current.slice(-39), entry];
    setDiagnosticReport(JSON.stringify({ version: 1, events: diagnosticRef.current }, null, 2));
  };
  const meterRef = useRef<HTMLButtonElement | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  useEffect(() => { onPreview?.(phase === "idle" ? "" : partial, phase === "idle" ? undefined : partialSpans); }, [partial, partialSpans, phase, onPreview]);
  const onTranscriptRef = useRef(onTranscript);
  const onActiveChangeRef = useRef(onActiveChange);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onActiveChangeRef.current = onActiveChange; }, [onActiveChange]);
  // Any non-idle capture state (permission, recording, transcribing) claims the row.
  useEffect(() => { onActiveChangeRef.current?.(phase !== "idle"); }, [phase]);

  /** Drive the analyser level meter straight into bar DOM heights (no re-renders). */
  function startMeter(capture: Capture) {
    const audio = capture.audio;
    if (!audio) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    audio.analyser.smoothingTimeConstant = reduced ? 0.2 : 0.85;
    const tick = () => {
      if (capture.cancelled) return;
      const el = meterRef.current;
      if (el && el.children.length > 0) {
        audio.analyser.getByteFrequencyData(audio.data);
        const bins = audio.data;
        const visibleBins = Math.floor(bins.length / 2);
        const count = el.children.length;
        for (let i = 0; i < count; i++) {
          const start = Math.floor((i * visibleBins) / count);
          const end = Math.max(start + 1, Math.floor(((i + 1) * visibleBins) / count));
          let sum = 0;
          for (let j = start; j < end; j++) sum += bins[j];
          const level = sum / (end - start) / 255;
          const pct = Math.max(6, Math.min(100, Math.round(Math.sqrt(level) * 100)));
          const bar = el.children[i] as HTMLElement; // children are exactly the rendered meter-bar spans
          bar.style.height = `${pct}%`;
        }
      }
      capture.raf = requestAnimationFrame(tick);
    };
    capture.raf = requestAnimationFrame(tick);
  }

  function cancel() {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      capture.cancelled = true;
      capture.request?.abort();
      if (capture.recorder?.state === "recording") capture.recorder.stop();
      release(capture);
      capture.live?.cancel();
    }
  }
  useEffect(
    () => () => {
      cancel();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    },
    [],
  );
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const capture = captureRef.current;
      if (!capture) return;
      if (capture.recorder?.state === "recording") {
        capture.sendAfterTranscription = false;
        capture.recorder.stop();
      } else if (!capture.recorder) {
        cancel();
        setPhase("idle");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function start() {
    if (captureRef.current) return;
    if (retained) return; // A kept recording must be discarded first; never overwrite it.
    setError(null);
    diagnosticStartRef.current = performance.now();
    diagnosticRef.current = [];
    recordDiagnostic("microphone-request");
    const capture: Capture = { cancelled: false };
    const liveCandidate = new LiveCapture();
    // Safari may suspend a context created after getUserMedia/config awaits. Allocate
    // and resume it from the button gesture, then reuse it in LiveCapture.start().
    try { liveCandidate.prepareAudio(); } catch { /* non-live POST capture may still work */ }
    capture.live = liveCandidate;
    captureRef.current = capture;
    setElapsed(0);
    setPhase("permission");
    try {
      const config = (liveConfigRef.current ?? detectLiveDictation()).catch(() => false);
      setPartial("");
      setPartialSpans(undefined);
      const microphone = navigator.mediaDevices.getUserMedia({ audio: true });
      let expired = false;
      const timeout = Promise.withResolvers<MediaStream>();
      const deadline = setTimeout(() => { expired = true; timeout.reject(new Error("Microphone did not respond. Tap the microphone to retry.")); }, 15_000);
      void microphone.then(stream => { if (expired || capture.cancelled) stream.getTracks().forEach(track => track.stop()); }, () => {});
      let stream: MediaStream;
      try { stream = await Promise.race([microphone, timeout.promise]); }
      finally { clearTimeout(deadline); }
      capture.stream = stream;
      recordDiagnostic("microphone-acquired", capture);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("mute", () => { if (!capture.cancelled && !capture.released) recordDiagnostic("microphone-muted", capture); });
        track.addEventListener("unmute", () => { if (!capture.cancelled && !capture.released) recordDiagnostic("microphone-unmuted", capture); });
        track.addEventListener("ended", () => { if (!capture.cancelled && !capture.released) recordDiagnostic("microphone-ended", capture); });
      }
      if (capture.cancelled) { release(capture); capture.live?.cancel(); return; }
      const liveEnabled = await config;
      if (capture.cancelled) { release(capture); capture.live?.cancel(); return; }
      setProvider(liveEnabled ? "Local" : "Google");
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error(t("dictation.unsupported"));
      const recorder = new MediaRecorder(stream, { mimeType });
      capture.recorder = recorder;
      const webkitWindow = window as unknown as { webkitAudioContext?: typeof AudioContext };
      const AudioCtor: typeof AudioContext | undefined = window.AudioContext ?? webkitWindow.webkitAudioContext;
      if (liveEnabled) {
        setConnecting(true);
        void capture.live!.connect((text, spans) => { if (!capture.cancelled) { setPartial(text); setPartialSpans(spans); } })
          .catch(cause => { if (!capture.cancelled) { recordDiagnostic("local-connect-failed", capture, cause); setProvider("Google fallback"); setPartial(""); } })
          .finally(() => { if (!capture.cancelled) setConnecting(false); });
        await capture.live!.start(stream);
        if (capture.cancelled) { capture.live?.cancel(); release(capture); return; }
      }
      const meterContext = capture.live?.getAudioContext() ?? (AudioCtor ? new AudioCtor() : undefined);
      if (meterContext) {
        const source = meterContext.createMediaStreamSource(stream);
        const analyser = meterContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        capture.audio = { ctx: meterContext, source, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
        void meterContext.resume().catch(() => {});
      }
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (capture.cancelled || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {
          cancel();
          setPhase("idle");
          setError(t("dictation.tooLarge"));
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (capture.cancelled) return;
        cancel();
        setPhase("idle");
        setError(t("dictation.recordingFailed"));
      };
      recorder.onstop = async () => {
        capture.releaseWakeLock?.();
        if (capture.cancelled) { release(capture); capture.live?.cancel(); return; }
        if (!bytes) {
          release(capture);
          capture.live?.cancel();
          captureRef.current = null;
          setPhase("idle");
          setError(t("dictation.empty"));
          return;
        }
        setPhase("transcribing");
        const request = new AbortController();
        capture.request = request;
        capture.timer = setTimeout(() => request.abort(), TRANSCRIBE_TIMEOUT_MS);
        const blob = new Blob(chunks, { type: mimeType });
        try {
          let text: string;
          try {
            if (!liveEnabled || !capture.live) throw new Error("Use Google");
            text = await capture.live.finish(() => release(capture));
          } catch (cause) {
            if (cause instanceof Error && cause.name === "AudioCaptureError") throw cause;
            recordDiagnostic("google-fallback", capture, cause);
            if (capture.cancelled) return;
            capture.live?.cancel();
            release(capture);
            setPartial("");
            capture.timer = setTimeout(() => request.abort(), TRANSCRIBE_TIMEOUT_MS);
            setProvider(liveEnabled ? "Google fallback" : "Google");
            text = await transcribePost(blob, mimeType, request.signal, t("dictation.failed"));
          }
          if (capture.cancelled || capture.transcriptDelivered) return;
          capture.transcriptDelivered = true;
          recordDiagnostic("transcription-completed", capture);
          onTranscriptRef.current(text, capture.sendAfterTranscription === true);
          setPhase("idle");
        } catch (cause) {
          if (capture.cancelled || capture.transcriptDelivered) return;
          recordDiagnostic("transcription-failed", capture, cause);
          // Keep the recording so the user can retry transcription or download it.
          setRetained({ blob, mimeType, ...(cause instanceof Error && cause.name === "AudioCaptureError" && capture.live ? { pcm: capture.live.pcm } : {}) });
          setError(request.signal.aborted ? t("dictation.timeout") : cause instanceof Error ? cause.message : t("dictation.failed"));
          setPhase("failed");
        } finally {
          release(capture);
          capture.live?.cancel();
          clearTimeout(capture.timer);
          capture.timer = undefined;
          if (!capture.cancelled) captureRef.current = null;
        }
      };
      recorder.start(1000);
      recordDiagnostic("recording", capture);
      keepScreenAwake(capture);
      capture.startedAt = performance.now();
      setElapsed(0);
      capture.interval = setInterval(() => {
        if (capture.startedAt != null) setElapsed(Math.floor((performance.now() - capture.startedAt) / 1000));
      }, 250);
      setPhase("recording");
      startMeter(capture);
      capture.timer = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_DURATION_MS);
    } catch (cause) {
      recordDiagnostic("startup-failed", capture, cause);
      release(capture);
      capture.live?.cancel();
      if (capture.cancelled) return;
      captureRef.current = null;
      setPhase("idle");
      setElapsed(0);
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? t("dictation.permissionDenied") : cause instanceof Error ? cause.message : t("dictation.recordingFailed"));
    }
  }

  /** Cancel the active capture and drop a kept recording — the explicit
   * discard that allows a fresh recording to start. */
  function discard() {
    cancel();
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setRetained(null);
    setError(null);
    setElapsed(0);
    setPhase("idle");
  }

  /** Re-run transcription on the kept recording: same blob, no re-capture,
   * and the result is inserted into the draft only — never re-sent. */
  async function retry() {
    if (!retained || captureRef.current) return;
    setError(null);
    setPhase("transcribing");
    const capture: Capture = { cancelled: false };
    captureRef.current = capture;
    const request = new AbortController();
    capture.request = request;
    capture.timer = setTimeout(() => request.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      let text: string;
      if (retained.pcm) {
        capture.live = new LiveCapture();
        await capture.live.connect(() => {});
        if (capture.cancelled) { capture.live.cancel(); return; }
        text = await capture.live.replay(retained.pcm);
      } else {
        text = await transcribePost(retained.blob, retained.mimeType, request.signal, t("dictation.failed"));
      }
      if (capture.cancelled) return;
      // A retry never repeats the original send intent.
      onTranscriptRef.current(text, false);
      setRetained(null);
      setElapsed(0);
      setPhase("idle");
    } catch (cause) {
      if (capture.cancelled) return;
      setError(request.signal.aborted ? t("dictation.timeout") : cause instanceof Error ? cause.message : t("dictation.failed"));
      setPhase("failed");
    } finally {
      clearTimeout(capture.timer);
      capture.live?.cancel();
      capture.timer = undefined;
      if (!capture.cancelled) captureRef.current = null;
    }
  }

  /** Save the kept recording via a temporary object URL; revoke it after the
   * download has started and again on unmount/discard if still pending. */
  function downloadRecording() {
    if (!retained) return;
    const base = retained.mimeType.split(";")[0].trim().toLowerCase();
    const extension = EXTENSION_BY_MIME[base] ?? "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const url = URL.createObjectURL(retained.blob);
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = url;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dictation-${stamp}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Defer the revoke so the browser has started the download before the URL dies.
    window.setTimeout(() => {
      if (downloadUrlRef.current === url) {
        URL.revokeObjectURL(url);
        downloadUrlRef.current = null;
      }
    }, 1000);
  }

  const active = phase !== "idle";
  const startLabel = t("dictation.start");
  const stopLabel = t("dictation.stop");
  const cancelLabel = t("dictation.cancel");
  const retryLabel = t("dictation.retry");
  const downloadLabel = t("dictation.download");
  const discardLabel = t("dictation.discard");
  const phaseLabel = t(phase === "recording" ? "dictation.recording" : phase === "permission" ? "dictation.permission" : phase === "failed" ? "dictation.failed" : "dictation.transcribing");
  const diagnosticsLabel = "Open recording diagnostics";
  return (
    <div className={active ? "dictation-control dictation-control--active" : "dictation-control"}>
      {!active ? (
        <button type="button" className="dictation-button" aria-label={startLabel} title={startLabel}
          onClick={() => void start()}>
          <Mic size={20} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : (
        <>
          <div className="dictation-row" role="group" aria-label={phaseLabel}>
            <button type="button" className="dictation-action" aria-label={phase === "failed" ? discardLabel : cancelLabel}
              title={phase === "failed" ? discardLabel : cancelLabel} onClick={discard}>
              <X size={18} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <div className="dictation-stage">
              <span className="dictation-sr-only" role="status">{provider}</span>
              {provider !== "Local" && active && <span className="dictation-connecting" title={provider}>{connecting ? `${provider} · ${t("dictation.connecting")}` : provider}</span>}
              {phase === "recording" && (
                <button type="button" className="dictation-meter" ref={meterRef} aria-label={diagnosticsLabel} title={diagnosticsLabel}
                  onClick={() => { if (diagnosticDetailsRef.current) diagnosticDetailsRef.current.open = !diagnosticDetailsRef.current.open; }}>
                  {Array.from({ length: METER_BARS }, (_, i) => <span key={i} className="dictation-meter-bar" aria-hidden="true" />)}
                </button>
                )}
              {phase === "permission" && (
                <span className="dictation-status" role="status">{t("dictation.permission")}</span>
              )}
              {phase === "transcribing" && (
                <span className="dictation-progress" role="status">
                  <Loader2 size={15} strokeWidth={2} className="dictation-spinner" aria-hidden="true" />
                  {t("dictation.transcribing")}
                </span>
              )}
              {phase === "failed" && error && (
                <span className="dictation-error" role="alert">{error}</span>
              )}
              <span className="dictation-timer" aria-hidden="true">{formatElapsed(elapsed)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {phase !== "failed" && (
                <button type="button" className="dictation-action dictation-action--stop" aria-label={phase === "recording" ? stopLabel : cancelLabel} title={phase === "recording" ? stopLabel : cancelLabel}
                  onClick={() => {
                    if (phase !== "recording") { discard(); return; }
                    const capture = captureRef.current;
                    if (!capture || capture.finishing || capture.recorder?.state !== "recording") return;
                    capture.finishing = true;
                    capture.recorder.stop();
                  }}>
                  <Square size={14} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
                </button>
              )}
              {phase === "failed" ? (
                <>
                  <button type="button" className="dictation-action dictation-action--primary" aria-label={retryLabel} title={retryLabel}
                    onClick={() => void retry()}>
                    <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button type="button" className="dictation-action" aria-label={downloadLabel} title={downloadLabel}
                    onClick={downloadRecording}>
                    <Download size={16} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <button type="button" className="composer-send" aria-label={sendLabel} title={sendLabel}
                  disabled={phase !== "recording"}
                  onClick={() => {
                    const capture = captureRef.current;
                    if (!capture || capture.finishing || capture.recorder?.state !== "recording") return;
                    capture.finishing = true;
                    capture.sendAfterTranscription = true;
                    capture.recorder.stop();
                  }}>
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <span className="dictation-sr-only" role="status">{phaseLabel}</span>
        </>
      )}
      {phase !== "failed" && error && <span className="dictation-error" role="alert">{error}</span>}
      {diagnosticReport && <details ref={diagnosticDetailsRef} className="dictation-diagnostics">
        <summary hidden>Recording diagnostics</summary>
        <div className="dictation-diagnostics-title">Recording diagnostics</div>
        <p>No audio, transcript, device names, or credentials are included.</p>
        <button type="button" onClick={() => void navigator.clipboard.writeText(diagnosticReport).catch(() => {})}>Copy diagnostics</button>
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>{diagnosticReport}</pre>
      </details>}
    </div>
  );
}