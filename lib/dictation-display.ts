export type DictationDisplayMode = "immediate" | "stable_words";
export interface DictationSpan { text: string; kind: "word" | "punctuation" | "spacing"; stable: boolean }
export const DICTATION_DISPLAY_KEY = "nook:dictation-display-mode";
export function readDictationDisplayMode(): DictationDisplayMode {
  try { return localStorage.getItem(DICTATION_DISPLAY_KEY) === "stable_words" ? "stable_words" : "immediate"; } catch { return "immediate"; }
}
export function parseDictationSpans(value: unknown, transcript: string): DictationSpan[] | undefined {
  if (!Array.isArray(value) || value.length > 20000) return;
  const spans: DictationSpan[] = [];
  for (const span of value) {
    if (!span || typeof span !== "object" || typeof span.text !== "string" || !["word", "punctuation", "spacing"].includes(span.kind) || typeof span.stable !== "boolean") return;
    spans.push({ text: span.text, kind: span.kind, stable: span.stable });
  }
  return spans.map(span => span.text).join("") === transcript ? spans : undefined;
}
