export type DictationDisplayMode = "immediate" | "stable_words" | "clean_tail";
export interface DictationSpan { text: string; kind: "word" | "punctuation" | "spacing" | "text"; stable: boolean }
export const DICTATION_DISPLAY_KEY = "nook:dictation-display-mode";
export function readDictationDisplayMode(): DictationDisplayMode {
  try { const mode = localStorage.getItem(DICTATION_DISPLAY_KEY); return mode === "stable_words" || mode === "clean_tail" ? mode : "immediate"; } catch { return "immediate"; }
}
export function parseDictationSpans(value: unknown, transcript: string): DictationSpan[] | undefined {
  if (!Array.isArray(value) || value.length > 20000) return;
  const spans: DictationSpan[] = [];
  for (const span of value) {
    if (!span || typeof span !== "object" || typeof span.text !== "string" || !["word", "punctuation", "spacing", "text"].includes(span.kind) || typeof span.stable !== "boolean") return;
    spans.push({ text: span.text, kind: span.kind, stable: span.stable });
  }
  return spans.map(span => span.text).join("") === transcript ? spans : undefined;
}
