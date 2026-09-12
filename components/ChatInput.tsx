"use client";

import type { DictationSpan } from "@/lib/dictation-display";
import { QuickReplies } from "./QuickReplies";
import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, memo, KeyboardEvent } from "react";
import { ChevronDown, ListChecks, Search, Target } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { ActiveGoal, ActivePlan } from "@/lib/web-mode-state";
import { formatGoalElapsed } from "@/lib/web-mode-state";
import type { ContextUsage } from "@/lib/pi-types";
import { formatCompactNumber } from "@/lib/format";
import { clearDraft, getDraft, setDraft, type ChatDraftFile, type ChatDraftImage } from "@/lib/draft-store";
import { WEB_SLASH_COMMANDS } from "@/lib/web-slash-commands";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import {
  composeMessageWithTextAttachments,
  MAX_ATTACHED_TEXT_BYTES,
  MAX_ATTACHED_TEXT_FILES,
  type AttachedTextFileData,
} from "@/lib/chat-attachments";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { selectableThinkingLevels } from "@/lib/thinking-levels";
import { DictationControl } from "./DictationControl";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

export type AttachedTextFile = AttachedTextFileData;

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void | boolean | Promise<void | boolean>;
  onAbort: () => void;
  /** Mid-run submit: abort the running agent and send the message as a fresh prompt (stop+send). Resolves true only when the interrupt+send was accepted; the composer clears its draft only on success. */
  onInterruptAndReply?: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; supportsFastMode?: boolean }[];
  modelError?: string | null;
  modelsLoading?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  fastModeSupported?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  /** Live context window usage (tokens/window/percent) for the composer ring. */
  contextUsage?: ContextUsage | null;
  thinkingLevel?: string;
  onThinkingLevelChange?: (level: string) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** Display name for the current model when the catalog does not know it. */
  modelNameOverride?: string | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  onAbortRetry?: () => void;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  /** True while the advisor model is actively reviewing the running turn. */
  advisorActive?: boolean;
  /** Resolved advisor role (display model + reasoning) for the composer tooltips. */
  advisorModel?: { name: string; reasoning: string | null } | null;
  /** Compact the session context from the composer toolbar. */
  onCompact?: () => void;
  /** Remove one queued message from the queue panel (Edit/Delete/Steer). */
  onRemoveQueuedMessage?: (text: string) => void;
  /** Relabel the first queued follow-up as a steering message. */
  onPromoteQueuedToSteer?: (text: string) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  activeGoal?: ActiveGoal | null;
  activePlan?: ActivePlan | null;
  advisorEnabled?: boolean;
  /** Toggle the per-chat advisor (composer icon + /advisor command). */
  onAdvisorChange?: (enabled: boolean) => void;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const COMPOSER_MODELS_STORAGE_KEY = "omp-composer-models";

function readVisibleModelKeys(): Set<string> | null {
  try {
    const value = JSON.parse(localStorage.getItem(COMPOSER_MODELS_STORAGE_KEY) ?? "null");
    return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : null;
  } catch {
    return null;
  }
}

function compareModelOptions(collator: Intl.Collator, a: ModelOption, b: ModelOption): number {
  return collator.compare(a.name || a.modelId, b.name || b.modelId)
    || collator.compare(a.provider, b.provider)
    || collator.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelOption[], query: string, locale: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return options;
  return options.filter((option) => (
    option.name.toLocaleLowerCase(locale).includes(normalizedQuery)
    || option.modelId.toLocaleLowerCase(locale).includes(normalizedQuery)
    || option.provider.toLocaleLowerCase(locale).includes(normalizedQuery)
  ));
}

/**
 * Device-touch heuristic for Enter behavior: phones/tablets insert a newline
 * with the keyboard's return key, desktop sends. Deliberately NOT viewport
 * based — a narrow desktop window must keep Enter-to-send.
 */
function detectTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (Number(navigator.maxTouchPoints) > 0) return true;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}


function formatTokenCount(tokens: number, locale: string): string {
  return formatCompactNumber(tokens, locale);
}

type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "ompBuiltin";

type SlashCommandPaletteItem = {
  name: string;
  description?: string;
  /** Bracketed argument hint rendered after the command name, e.g. "[goal]". */
  argumentHint?: string;
  source: SlashCommandSource;
};

function isDormantSkillCommand(command: SlashCommandPaletteItem, dormantNames: Set<string>): boolean {
  return command.source === "skill" && dormantNames.has(command.name);
}

const BUILTIN_SLASH_COMMAND_DEFS: { name: string; descriptionKey: string; argumentHintKey?: string }[] = [
  // Web-native prompt-composing commands (goal/plan/... are TUI-only in omp and
  // never execute over the RPC prompt path — see lib/web-slash-commands.ts).
  ...WEB_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    descriptionKey: command.descriptionKey,
    argumentHintKey: command.argumentHintKey,
  })),
  { name: "compact", descriptionKey: "chatInput.cmdCompact" },
  { name: "reload", descriptionKey: "chatInput.cmdReload" },
  { name: "name", descriptionKey: "chatInput.cmdName" },
  { name: "session", descriptionKey: "chatInput.cmdSession" },
  { name: "copy", descriptionKey: "chatInput.cmdCopy" },
];

const CLIENT_BUILTIN_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMAND_DEFS.map((def) => def.name));

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill", "ompBuiltin"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chatInput.groupBuiltin",
  extension: "chatInput.groupExtensions",
  prompt: "chatInput.groupPrompts",
  skill: "chatInput.groupSkills",
  ompBuiltin: "chatInput.groupOmpBuiltin",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
  ompBuiltin: 4,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}
function textFileToDraftFile(file: AttachedTextFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, content: file.content, size: file.size };
}

function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedTextFile[] {
  return (files ?? [])
    .filter((file) => typeof file.name === "string"
      && typeof file.mimeType === "string"
      && typeof file.content === "string"
      && Number.isFinite(file.size)
      && file.size <= MAX_ATTACHED_TEXT_BYTES)
    .slice(0, MAX_ATTACHED_TEXT_FILES);
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

/** Compact action button for the queued follow-up bar. */
function QueuedActionButton({
  onClick,
  title,
  accent = false,
  children,
}: {
  onClick: () => void;
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        flexShrink: 0,
        padding: "4px 8px", minHeight: 24,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: accent ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: accent ? 600 : 400,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        if (!accent) e.currentTarget.style.color = "var(--text-muted)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        if (!accent) e.currentTarget.style.color = "var(--text-dim)";
      }}
    >
      {children}
    </button>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: "1px solid color-mix(in srgb, var(--status-error) 35%, transparent)",
        borderRadius: "var(--radius-control)",
        background: "color-mix(in srgb, var(--status-error) 8%, transparent)",
        color: "var(--status-error)",
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t("chatInput.modelError")}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</div>
      </div>
    </div>
  );
}

function ComposerModeStatus({ goal, plan }: { goal?: ActiveGoal | null; plan?: ActivePlan | null }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const goalId = goal?.id;

  useEffect(() => {
    if (!goalId) return;
    setExpanded(false);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goalId]);

  if (!goal && !plan) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      {goal && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? t("chatInput.collapseGoal") : t("chatInput.expandGoal")}
          style={{
            display: "flex", alignItems: expanded ? "flex-start" : "center", gap: 8,
            width: "100%", padding: "6px 9px",
            border: "1px solid color-mix(in srgb, var(--accent) 32%, var(--border))",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))",
            color: "var(--text)", cursor: "pointer", textAlign: "left",
            transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <Target size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: expanded ? 1 : 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t(`chatInput.goal${goal.status[0].toUpperCase()}${goal.status.slice(1)}` as "chatInput.goalActive")} · {formatGoalElapsed(now - goal.startedAt)}
          </span>
          <span style={{ minWidth: 0, flex: 1, overflow: expanded ? "visible" : "hidden", textOverflow: expanded ? undefined : "ellipsis", whiteSpace: expanded ? "pre-wrap" : "nowrap", fontSize: 12, lineHeight: 1.4 }}>
            {goal.objective}
            {expanded && goal.summary && <span style={{ display: "block", marginTop: 4, color: "var(--text-muted)" }}>{goal.summary}</span>}
            {expanded && <span style={{ display: "block", marginTop: 4, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>/goal pause · /goal resume · /goal clear</span>}
          </span>
        </button>
      )}
      {plan && (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
          <ListChecks size={14} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>{t("chatInput.planningInProgress")}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>{plan.objective}</span>
        </div>
      )}
    </div>
  );
}

export const ChatInput = memo(forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onInterruptAndReply, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelsLoading, onModelChange, fastModeEnabled, fastModeActive, fastModeSupported, onFastModeChange,
  onAbortCompaction, isCompacting, compactResult,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap, modelNameOverride,
  retryInfo, queuedMessages, inputHistory = [], onAbortRetry,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  advisorActive,
  advisorModel,
  onCompact,
  onRemoveQueuedMessage,
  onPromoteQueuedToSteer,
  draftKey,
  cwd,
  activeGoal,
  activePlan,
  advisorEnabled,
  contextUsage,
  onAdvisorChange,
}: Props, ref) {
  const isMobile = useIsMobile();
  const { t, tn, locale } = useI18n();
  const modelCollator = React.useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }),
    [locale],
  );
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>(() => (
    draftKey ? draftFilesToAttachedFiles(getDraft(draftKey)?.files) : []
  ));
  const [attachError, setAttachError] = useState<string | null>(null);
  // Device capability (maxTouchPoints / coarse pointer), not viewport width:
  // phones and tablets newline on Enter, desktop submits.
  const [isTouchDevice] = useState(detectTouchDevice);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!isTouchDevice || !viewport) return;
    const update = () => {
      const focused = document.activeElement;
      const editing = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || (focused instanceof HTMLElement && focused.isContentEditable);
      const occluded = document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      setKeyboardOpen(editing && Math.abs(viewport.scale - 1) < 0.05 && occluded > 100);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [isTouchDevice]);
  // True while dictation is capturing (permission/recording/transcribing);
  // the parent then hides the toolbar row and the control takes the row.
  const previewOverlayRef = useRef<HTMLDivElement>(null);
  const [previewSpans, setPreviewSpans] = useState<DictationSpan[] | undefined>();
  const acceptPreview = useCallback((text: string, spans?: DictationSpan[]) => { setDictationPreview(text); setPreviewSpans(spans); }, []);
  const [dictationPreview, setDictationPreview] = useState("");
  const [dictationActive, setDictationActive] = useState(false);
  const [typingFocused, setTypingFocused] = useState(false);
  const editorValue = value + (dictationPreview ? (value && !/\s$/.test(value) ? " " : "") + dictationPreview : "");
  const [dictationSubmit, setDictationSubmit] = useState(false);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && attachedTextFiles.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const attachedTextFilesRef = useRef(attachedTextFiles);
  // Bumped whenever the user clears/sends the composer: in-flight FileReader
  // and file.text() reads must not re-append their results afterwards.
  const attachmentRevisionRef = useRef(0);
  const pendingImageCountRef = useRef(0);
  const pendingTextFileCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedTextFilesRef.current = attachedTextFiles;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addFiles(files: File[]) {
      processFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) {
      if (files.length > 0) {
        setAttachError(
          remaining === 0
            ? `Maximum of ${MAX_ATTACHED_IMAGES} attached images reached.`
            : `${files.length} image(s) skipped: images up to ${Math.round(MAX_ATTACHED_IMAGE_BYTES / 1024 / 1024)} MB are supported.`,
        );
      }
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingImageCountRef.current += imageFiles.length;
    const created: AttachedImage[] = [];
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                const image = { data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) };
                created.push(image);
                resolve(image);
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) {
        newImages.forEach(revokeImagePreview);
        return;
      }
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        return [...prev, ...accepted];
      });
      setAttachError(null);
    } catch {
      // A failed read in the batch must not leak the siblings' blob URLs.
      created.forEach(revokeImagePreview);
      setAttachError("One or more images could not be read. Try a different file.");
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, []);

  const processTextFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_TEXT_FILES - attachedTextFilesRef.current.length - pendingTextFileCountRef.current,
    );
    const textFiles = files
      .filter((file) => file.size <= MAX_ATTACHED_TEXT_BYTES)
      .slice(0, remaining);
    if (!textFiles.length) {
      if (files.length > 0) {
        setAttachError(
          remaining === 0
            ? `Maximum of ${MAX_ATTACHED_TEXT_FILES} text files reached.`
            : `${files.length} file(s) skipped: files up to ${Math.round(MAX_ATTACHED_TEXT_BYTES / 1024)} KB are supported.`,
        );
      }
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingTextFileCountRef.current += textFiles.length;
    try {
      const readFiles = await Promise.all(
        textFiles.map(async (file): Promise<AttachedTextFile> => ({
          name: file.name,
          mimeType: file.type,
          content: await file.text(),
          size: file.size,
        })),
      );
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) return;
      // Binary content cannot be inlined into the prompt: NUL bytes, or
      // U+FFFD replacement characters left by mis-decoded binary (e.g.
      // UTF-16 text read as UTF-8).
      const newFiles = readFiles.filter(
        (file) => !file.content.includes("\u0000") && !file.content.includes("\uFFFD"),
      );
      const skipped = textFiles.length - newFiles.length;
      setAttachedTextFiles((prev) => [
        ...prev,
        ...newFiles.slice(0, Math.max(0, MAX_ATTACHED_TEXT_FILES - prev.length)),
      ]);
      if (skipped > 0) {
        setAttachError(`${skipped} file(s) skipped: binary or non-text files cannot be attached.`);
      } else {
        setAttachError(null);
      }
    } catch {
      setAttachError("One or more files could not be read. Try a different file.");
    } finally {
      pendingTextFileCountRef.current -= textFiles.length;
    }
  }, []);

  const processFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    void processImageFiles(imageFiles);
    void processTextFiles(otherFiles);
  }, [processImageFiles, processTextFiles]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
    setAttachError(null);
  }, []);

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index));
    setAttachError(null);
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearTextFiles = useCallback(() => {
    setAttachedTextFiles([]);
  }, []);

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    clearTextFiles();
    // Invalidate any attachment reads still in flight.
    attachmentRevisionRef.current += 1;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, clearTextFiles, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      files: attachedTextFiles.map(textFileToDraftFile),
    });
  }, [attachedImages, attachedTextFiles, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        files: attachedTextFilesRef.current.map(textFileToDraftFile),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft?.images);
    });
    setAttachedTextFiles(draftFilesToAttachedFiles(draft?.files));
  }, [draftKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (editorValue) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    if (dictationActive && dictationPreview) { ta.scrollTop = ta.scrollHeight; if (previewOverlayRef.current) previewOverlayRef.current.scrollTop = ta.scrollTop; }
  }, [editorValue, dictationActive, dictationPreview]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const latestDraftRef = useRef({ value, attachedImages, attachedTextFiles, draftKey });
  latestDraftRef.current = { value, attachedImages, attachedTextFiles, draftKey };
  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (submittingRef.current) return;
    const snapshot = latestDraftRef.current;
    if (snapshot.value !== value || snapshot.attachedImages !== attachedImages || snapshot.attachedTextFiles !== attachedTextFiles) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const clearSubmittedDraft = () => {
      const latest = latestDraftRef.current;
      if (latest.value === value && latest.attachedImages === attachedImages && latest.attachedTextFiles === attachedTextFiles && latest.draftKey === snapshot.draftKey) {
        latestDraftRef.current = { ...latest, value: "" };
        clearInput();
      }
    };
    try {
      onAudioUnlock?.();
      const composedMessage = composeMessageWithTextAttachments(msg, attachedTextFiles);
      const images = attachedImages.length ? attachedImages : undefined;
      // Builtin slash commands are dispatched to the session regardless of run
      // state; unknown /commands fall through to the agent like plain text.
      if (!attachedImages.length && !attachedTextFiles.length && msg.startsWith("/") && onBuiltinCommand) {
        const result = await onBuiltinCommand(msg);
        if (result.handled) {
          if (!result.error && !result.retainInput) clearSubmittedDraft();
          return;
        }
      }
      if (isStreaming) {
        // Mid-run submit defaults to stop+send: interrupt the current run and
        // deliver the composer contents as a fresh prompt. Clear only on
        // success so a failed interrupt keeps the draft intact.
        if (!onInterruptAndReply) return;
        const ok = await onInterruptAndReply(composedMessage, images);
        if (ok) clearSubmittedDraft();
        else setSubmitError("Message not sent. Your draft is kept; try again.");
        return;
      }
      const accepted = await onSend(composedMessage, images);
      if (accepted !== false) clearSubmittedDraft();
      else setSubmitError("Message not sent. Your draft is kept; try again.");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Message not sent. Your draft is kept.");
    } finally { submittingRef.current = false; setSubmitting(false); }
  }, [value, attachedImages, attachedTextFiles, isStreaming, onBuiltinCommand, onInterruptAndReply, onSend, clearInput, onAudioUnlock]);


  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
  const [dormantSkillNames, setDormantSkillNames] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (slashQuery === null || !cwd) return;
    const controller = new AbortController();
    void fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ skills?: Array<{ name?: string; disableModelInvocation?: boolean }> }> : null)
      .then((data) => {
        if (!data) return;
        setDormantSkillNames(new Set((data.skills ?? []).flatMap((skill) => skill.disableModelInvocation && skill.name ? [skill.name] : [])));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [cwd, slashQuery]);

  const builtinSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => BUILTIN_SLASH_COMMAND_DEFS
      // The /advisor command is linked to Settings → Enable Advisor: hidden
      // from the palette while the advisor is disabled.
      .filter((def) => def.name !== "advisor" || advisorEnabled)
      .map((def) => ({
        name: def.name,
        description: t(def.descriptionKey),
        ...(def.argumentHintKey ? { argumentHint: t(def.argumentHintKey) } : {}),
        source: "builtin" as const,
      })),
    [t, advisorEnabled],
  );

  // Externally reported commands (extension/prompt/skill/ompBuiltin) group
  // below the client built-ins; any name the web UI intercepts itself —
  // whether an omp builtin or a user extension — is dropped so each command
  // appears exactly once and the client interception behavior is unchanged.
  const externalSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => (slashCommands ?? []).flatMap((command): SlashCommandPaletteItem[] => {
      const source = command.source as string;
      if (CLIENT_BUILTIN_COMMAND_NAMES.has(command.name)) return [];
      if (source === "builtin" || source === "ompBuiltin") {
        return [{ name: command.name, description: command.description, source: "ompBuiltin" }];
      }
      return [command];
    }),
    [slashCommands],
  );

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : builtinSlashCommands), ...externalSlashCommands];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        const dormancyDelta = Number(isDormantSkillCommand(a, dormantSkillNames)) - Number(isDormantSkillCommand(b, dormantSkillNames));
        if (dormancyDelta !== 0) return dormancyDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || modelCollator.compare(a.name, b.name);
      });
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = slashQuery
    ? tn("chatInput.matchCount", filteredSlashCommands.length)
    : tn("chatInput.commandCount", filteredSlashCommands.length);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  useEffect(() => {
    if (!dictationSubmit) return;
    setDictationSubmit(false);
    // Recording send follows the same submit path as the Send button: a
    // running agent is interrupted and the transcript is delivered as a
    // fresh prompt (stop+send).
    void handleSend();
  }, [dictationSubmit, handleSend]);

  // ── Queued follow-up bar ────────────────────────────────────────────────
  // omp reports only a queued count over RPC; the texts are tracked in a
  // client-side mirror, so Edit/Delete/Steer act on that mirror through the
  // session hook's helpers.
  const queuedEntries = [
    ...(queuedMessages?.followUp ?? []).map((text) => ({ kind: "follow-up" as const, text })),
    ...(queuedMessages?.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
  ];
  const firstQueued = queuedEntries[0] ?? null;
  const queuedCount = queuedEntries.length;

  const [queueExpanded, setQueueExpanded] = useState(false);

  const handleItemEdit = useCallback((text: string) => {
    onRemoveQueuedMessage?.(text);
    setValue(text);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [onRemoveQueuedMessage]);

  const handleItemDelete = useCallback((text: string) => {
    onRemoveQueuedMessage?.(text);
  }, [onRemoveQueuedMessage]);

  const handleItemSteer = useCallback((entry: { kind: "follow-up" | "steer"; text: string }) => {
    if (entry.kind === "follow-up") {
      onPromoteQueuedToSteer?.(entry.text);
    }
  }, [onPromoteQueuedToSteer]);

  const handleQueuedEdit = useCallback(() => {
    if (!firstQueued) return;
    handleItemEdit(firstQueued.text);
  }, [firstQueued, handleItemEdit]);

  const handleQueuedDelete = useCallback(() => {
    if (!firstQueued) return;
    handleItemDelete(firstQueued.text);
  }, [firstQueued, handleItemDelete]);

  const handleQueuedSteer = useCallback(() => {
    if (!firstQueued) return;
    handleItemSteer(firstQueued);
  }, [firstQueued, handleItemSteer]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      // Desktop Enter submits through the same path as the Send button —
      // idle sends normally, mid-run stops the agent and sends (stop+send).
      if (e.key === "Enter" && !e.shiftKey) {
        // Touch devices always insert a newline; only the arrow submits.
        // Desktop: Enter submits, Shift+Enter inserts a newline.
        // (The IME guard above already released composition-enters.)
        if (isTouchDevice) return;
        e.preventDefault();
        void handleSend();
      }
    },
    [isStreaming, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, isTouchDevice]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (dictationActive) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processFiles(files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (text.length < 2000 && text.split(/\r\n|\r|\n/).length < 30) return;
    e.preventDefault();
    const size = new TextEncoder().encode(text).byteLength;
    if (size > MAX_ATTACHED_TEXT_BYTES) {
      setAttachError(`Paste exceeds the ${Math.round(MAX_ATTACHED_TEXT_BYTES / 1024)} KB text attachment limit. Your clipboard and draft are unchanged.`);
      return;
    }
    if (attachedTextFilesRef.current.length + pendingTextFileCountRef.current >= MAX_ATTACHED_TEXT_FILES) {
      setAttachError(`Maximum of ${MAX_ATTACHED_TEXT_FILES} text attachments reached. Your clipboard and draft are unchanged.`);
      return;
    }
    let number = 1;
    const names = new Set(attachedTextFilesRef.current.map(file => file.name));
    while (names.has(`Pasted text ${number}.txt`)) number++;
    const attachment: AttachedTextFile = { name: `Pasted text ${number}.txt`, mimeType: "text/plain", content: text, size };
    // Clipboard text is already decoded: preserve it verbatim, including NUL,
    // replacement characters, whitespace, and line endings.
    const next = [...attachedTextFilesRef.current, attachment];
    attachedTextFilesRef.current = next;
    setAttachedTextFiles(next);
    setAttachError(null);
  }, [dictationActive, processFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const [visibleModelKeys, setVisibleModelKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    const refresh = () => setVisibleModelKeys(readVisibleModelKeys());
    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === COMPOSER_MODELS_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("omp-composer-models-change", refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener("omp-composer-models-change", refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);

  const modelOptions: ModelOption[] = React.useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))
        .filter((m) => visibleModelKeys === null || visibleModelKeys.has(`${m.provider}:${m.modelId}`))
        .sort((a, b) => compareModelOptions(modelCollator, a, b));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort((a, b) => compareModelOptions(modelCollator, a, b));
  }, [modelList, modelNames, model?.provider, visibleModelKeys, modelCollator]);

  const filteredModelOptions = React.useMemo(
    () => filterModelOptions(modelOptions, modelSearchQuery, locale),
    [locale, modelOptions, modelSearchQuery],
  );

  // Group options by provider, preserving insertion order.
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = React.useMemo(() => {
    const groups: { provider: string; options: ModelOption[] }[] = [];
    for (const opt of filteredModelOptions) {
      const group = groups.find((g) => g.provider === opt.provider);
      if (group) group.options.push(opt);
      else groups.push({ provider: opt.provider, options: [opt] });
    }
    return groups;
  }, [filteredModelOptions]);

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name
        ?? modelNameOverride
        ?? modelNames?.[`${model.provider}:${model.modelId}`]
        ?? model.modelId)
    : null;
  const currentName = displayModelName;
  // A failed load surfaces modelError; only an in-flight load shows the
  // loading chip, so "no models" can only appear after the fetch settled.
  const showModelsLoading = Boolean(modelsLoading) && !modelError;
  const modelSelectorDisabled = showModelsLoading && modelOptions.length === 0;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactVerb = compactResult?.reason && compactResult.reason !== "manual"
    ? t("chatInput.compactedWithReason", {
        reason: `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)}`,
      })
    : t("chatInput.compacted");
  const compactResultText = compactResult
    ? t("chatInput.compactResult", {
        verb: compactVerb,
        before: formatTokenCount(compactResult.tokensBefore, locale),
        after: formatTokenCount(compactResult.estimatedTokensAfter, locale),
        saved: formatTokenCount(compactSavedTokens, locale),
      })
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const thinkingLevelOptions = React.useMemo(
    () => selectableThinkingLevels(availableThinkingLevels),
    [availableThinkingLevels],
  );

  useEffect(() => {
    if (!modelDropdownOpen) {
      setModelSearchQuery("");
      return;
    }
    requestAnimationFrame(() => modelSearchInputRef.current?.focus());
  }, [modelDropdownOpen]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
         padding: `0 var(--composer-gutter, 16px) ${keyboardOpen ? "8px" : "calc(8px + env(safe-area-inset-bottom))"}`,
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        // Accept every file type: the handler below reads any non-image file
        // as text (rejecting binary content), so restricting the picker would
        // only hide files the app can attach (code, config, logs, ...).
        accept="*/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ComposerModeStatus goal={activeGoal} plan={activePlan} />
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 25%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-warning)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("chatInput.retrying", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
            {onAbortRetry && (
              <button
                type="button"
                onClick={onAbortRetry}
                title="Stop the automatic retry and leave the failed turn as-is"
                style={{
                  marginLeft: "auto",
                  padding: "3px 9px",
                  fontSize: 11,
                  color: "var(--status-warning)",
                  background: "transparent",
                  border: "1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--status-warning) 12%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Abort retry
              </button>
            )}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-success) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-success) 24%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-success)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Image previews */}
        {attachError && (
          <div role="alert" style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-error) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-error)",
          }}>
            {attachError}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative" }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chatInput.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                maxHeight: "min(56vh, 460px)",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                <span>{slashCommandsLoading ? t("chatInput.loadingCommands") : t("chatInput.slashCommandsHeader", { countLabel: slashCommandCountLabel })}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
              </div>
              <div style={{ maxHeight: "calc(min(56vh, 460px) - 34px)", overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("chatInput.noCommandsFound")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, dormantSkillNames);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: dormant ? "var(--text-dim)" : "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}>
                                /{command.name}
                                {command.argumentHint && (
                                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{command.argumentHint}</span>
                                )}
                                {dormant && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{t("chatInput.dormant")}</span>}
                              </span>
                              {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
            const matchCountLabel = tn("chatInput.matchCount", atMatches.length);
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
              ? ` · ${atQuery.query ? t("chatInput.searchingAllFiles") : t("chatInput.indexTruncated")}`
              : "";
            return (
              <div
                className="dropdown-surface"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                      ? t("chatInput.loadingFiles")
                      : `${t("chatInput.filesHeader", { countLabel: matchCountLabel })}${truncatedHint}`}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                      {needsServerSearch && !serverResultInUse ? t("chatInput.searching") : t("chatInput.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
        {/* Queued prompts panel / bar — attached to composer's top edge.
            When 1 item: compact single row. When multiple items: compact row with expand toggle, or full list when expanded. */}
        {queuedCount > 0 && (
          <div
            aria-label={t("chatInput.queuedPrompts")}
            style={{
              border: "1px solid var(--border)",
              borderBottom: "none",
              borderRadius: "var(--radius-card) var(--radius-card) 0 0",
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            {queuedCount === 1 ? (
              <div style={{
                padding: "5px 8px 5px 12px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}>
                <span style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}>
                  {firstQueued?.kind === "steer" ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
                </span>
                <span
                  title={firstQueued?.text}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {firstQueued?.text}
                </span>
                <QueuedActionButton onClick={handleQueuedEdit} title={t("chatInput.queuedEditTitle")}>
                  {t("chatInput.queuedEdit")}
                </QueuedActionButton>
                <QueuedActionButton onClick={handleQueuedDelete} title={t("chatInput.queuedDeleteTitle")}>
                  {t("chatInput.queuedDelete")}
                </QueuedActionButton>
                <QueuedActionButton onClick={handleQueuedSteer} title={t("chatInput.queuedSteerTitle")} accent>
                  {t("chatInput.queuedSteerAction")}
                </QueuedActionButton>
              </div>
            ) : (
              <div>
                <div style={{
                  padding: "5px 8px 5px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  borderBottom: queueExpanded ? "1px solid var(--border)" : "none",
                }}>
                  <button
                    type="button"
                    onClick={() => setQueueExpanded((prev) => !prev)}
                    aria-expanded={queueExpanded}
                    title={queueExpanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      minWidth: 0,
                      flex: 1,
                      textAlign: "left",
                    }}
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      style={{
                        transform: queueExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                        transition: "transform var(--dur-fast) var(--ease-out-warm)",
                        flexShrink: 0,
                      }}
                      aria-hidden
                    />
                    <span>{t("chatInput.queuedPrompts")}</span>
                    <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>({queuedCount})</span>
                    {!queueExpanded && firstQueued && (
                      <span
                        style={{
                          marginLeft: 4,
                          color: "var(--text-dim)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 11,
                          fontWeight: 400,
                          textTransform: "none",
                        }}
                      >
                        {firstQueued.kind === "steer" ? `[${t("chatInput.queuedSteer")}] ` : ""}{firstQueued.text}
                      </span>
                    )}
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setQueueExpanded((prev) => !prev)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "2px 6px",
                        cursor: "pointer",
                        color: "var(--text-dim)",
                        fontSize: 11,
                      }}
                    >
                      {queueExpanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
                    </button>
                  </div>
                </div>
                {queueExpanded && (
                  <div style={{
                    maxHeight: 180,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    background: "var(--bg-subtle)",
                    padding: "4px 0",
                  }}>
                    {queuedEntries.map((entry, idx) => (
                      <div
                        key={`${entry.kind}:${idx}:${entry.text}`}
                        style={{
                          padding: "4px 8px 4px 12px",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          background: "var(--bg-panel)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{
                          flexShrink: 0,
                          fontSize: 9.5,
                          fontWeight: 600,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          padding: "1px 4px",
                          borderRadius: 4,
                          background: entry.kind === "steer" ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg)",
                          border: `1px solid ${entry.kind === "steer" ? "var(--accent)" : "var(--border)"}`,
                          color: entry.kind === "steer" ? "var(--accent)" : "var(--text-muted)",
                        }}>
                          {entry.kind === "steer" ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
                        </span>
                        <span
                          title={entry.text}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--text)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 11.5,
                          }}
                        >
                          {entry.text}
                        </span>
                        <QueuedActionButton onClick={() => handleItemEdit(entry.text)} title={t("chatInput.queuedEditTitle")}>
                          {t("chatInput.queuedEdit")}
                        </QueuedActionButton>
                        <QueuedActionButton onClick={() => handleItemDelete(entry.text)} title={t("chatInput.queuedDeleteTitle")}>
                          {t("chatInput.queuedDelete")}
                        </QueuedActionButton>
                        {entry.kind === "follow-up" && (
                          <QueuedActionButton onClick={() => handleItemSteer(entry)} title={t("chatInput.queuedSteerTitle")} accent>
                            {t("chatInput.queuedSteerAction")}
                          </QueuedActionButton>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
          <div
            className="chat-input-shell"
            style={{
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: "var(--radius-card)",
              padding: "14px 16px 12px 16px",
              boxShadow: "var(--shadow-card)",
              transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
            } as React.CSSProperties}
          >
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  title="Remove image"
                  aria-label="Remove image"
                  style={{
                    position: "absolute", top: -5, right: -5,
                    width: 24, height: 24, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {attachedTextFiles.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedTextFiles.map((file, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  maxWidth: 260, height: 30,
                  padding: "0 6px 0 9px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  fontSize: 12,
                  color: "var(--text)",
                }}
              >
                <span style={{ flexShrink: 0, display: "flex", color: "var(--text-muted)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <span
                  title={file.name}
                  style={{
                    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)", fontSize: 11.5,
                  }}
                >
                  {file.name}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
                  {file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}
                </span>
                <button
                  onClick={() => removeTextFile(i)}
                  title="Remove file"
                  aria-label="Remove file"
                  style={{
                    flexShrink: 0, width: 18, height: 18,
                    borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "transparent", border: "none",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
          <div className="composer-writing-area">
          <textarea
            ref={textareaRef}
            autoComplete="off"
            onFocus={() => setTypingFocused(true)}
            onBlur={() => setTypingFocused(false)}
            value={editorValue}
            readOnly={dictationActive}
            onScroll={event => { if (previewOverlayRef.current) previewOverlayRef.current.scrollTop = event.currentTarget.scrollTop; }}
            onChange={(e) => {
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder="Type here…"
            rows={2}
            style={{
              display: "block",
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: dictationPreview && previewSpans ? "transparent" : "var(--text)",
              fontSize: 16,
              lineHeight: 1.5,
              fontFamily: "inherit",
              minHeight: 48,
              maxHeight: 200,
              overflow: "auto",
            }}
          />
          {dictationPreview && previewSpans && <div ref={previewOverlayRef} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", fontFamily: "inherit", fontSize: 16, lineHeight: 1.5, color: "var(--text)" }}>{value}{value && !/\s$/.test(value) ? " " : ""}{previewSpans.map((span,index)=><span key={index} style={{color:span.kind === "punctuation" && !span.stable ? "var(--text-dim)" : "var(--text)"}}>{span.text}</span>)}</div>}
          <div className="composer-reply-line" style={{ visibility: !value && !attachedImages.length && !attachedTextFiles.length && !dictationActive && !submitting && !typingFocused ? "visible" : "hidden" }} inert={Boolean(value || attachedImages.length || attachedTextFiles.length || dictationActive || submitting || typingFocused)}>
            <QuickReplies onReply={message => isStreaming && onInterruptAndReply ? onInterruptAndReply(message) : onSend(message)} />
          </div>
          </div>
          {/* Toolbar: + attachment (labelled menu) · context ring · model · reasoning · dictation · send/stop */}
          {submitError && <div role="alert" style={{color:"var(--status-error)",fontSize:12,marginTop:6}}>{submitError}</div>}
          <div className="composer-toolbar" aria-busy={submitting}>
            {!dictationActive && (
              <Menu.Root>
                <Menu.Trigger
                  render={(props) => (
                    <button
                      {...props}
                      type="button"
                      className="composer-round-button"
                      aria-label={t("chatInput.attachFile")}
                      title={t("chatInput.attachFile")}
                      data-attached={(attachedImages.length || attachedTextFiles.length) ? "true" : "false"}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                      </svg>
                    </button>
                  )}
                />
                <Menu.Portal>
                  <Menu.Positioner side="top" align="start" sideOffset={8}>
                    <Menu.Popup className="composer-menu">
                      <Menu.Item
                        className="composer-menu-item"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span className="composer-menu-item-label">{t("chatInput.menuAttach")}</span>
                      </Menu.Item>
                      <Menu.Separator className="composer-menu-separator" />
                      {onAdvisorChange && (
                        <Menu.CheckboxItem
                          className="composer-menu-item"
                          checked={advisorEnabled}
                          onCheckedChange={(next) => onAdvisorChange(next)}
                          title={advisorEnabled
                            ? t("chatInput.advisorDisableTitle", { model: advisorModel?.name ?? t("messageView.advisorLabel"), reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault") })
                            : t("chatInput.advisorEnableTitle")}
                        >
                          <span className="composer-menu-item-label">{t("chatInput.menuAdvisor")}</span>
                          <span className="composer-menu-sub">
                            {advisorEnabled
                              ? `${advisorModel?.name ?? t("chatInput.menuOn")}${advisorActive ? ` · ${t("chatInput.advisorReviewing")}` : ""}`
                              : t("chatInput.menuOff")}
                          </span>
                          {advisorEnabled && (
                            <span className="composer-menu-check" aria-hidden="true">
                              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            </span>
                          )}
                        </Menu.CheckboxItem>
                      )}
                      {fastModeSupported && onFastModeChange && (
                        <Menu.CheckboxItem
                          className="composer-menu-item"
                          checked={fastModeEnabled}
                          onCheckedChange={(next) => onFastModeChange(next)}
                          title={fastModeEnabled && fastModeActive === false ? "Fast mode is enabled but inactive for this model" : `Turn OMP Fast mode ${fastModeEnabled ? "off" : "on"} for this model`}
                        >
                          <span className="composer-menu-item-label">{t("chatInput.menuFast")}</span>
                          <span className="composer-menu-sub">
                            {fastModeEnabled && fastModeActive === false ? t("chatInput.fastInactive") : fastModeEnabled ? t("chatInput.menuOn") : t("chatInput.menuOff")}
                          </span>
                          {fastModeEnabled && (
                            <span className="composer-menu-check" aria-hidden="true">
                              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            </span>
                          )}
                        </Menu.CheckboxItem>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            )}

            {!dictationActive && <div style={{ flex: 1, minWidth: 0 }} />}

            {!dictationActive && (contextUsage || onCompact) && (
              <Popover.Root>
                <Popover.Trigger
                  render={(props) => (
                    <button
                      {...props}
                      type="button"
                      className="composer-ring-button"
                      aria-label={t("chatInput.contextUsageTitle")}
                      title={contextUsage && contextUsage.percent != null
                        ? t("chatInput.contextPercent", { percent: Math.round(contextUsage.percent) })
                        : t("chatInput.contextUsageTitle")}
                    >
                      {(() => {
                        const percent = contextUsage?.percent ?? null;
                        const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));
                        const R = 8;
                        const C = 2 * Math.PI * R;
                        const dash = C * (1 - pct / 100);
                        const stroke = percent == null
                          ? "var(--text-dim)"
                          : percent >= 85 ? "var(--status-warning)" : "var(--accent)";
                        return (
                          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r={R} fill="none" stroke="var(--bg-selected)" strokeWidth="2.5" />
                            <circle
                              cx="12" cy="12" r={R} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round"
                              strokeDasharray={C.toFixed(2)} strokeDashoffset={dash.toFixed(2)}
                              transform="rotate(-90 12 12)"
                              style={{ transition: "stroke-dashoffset var(--dur-med) var(--ease-out-warm), stroke var(--dur-med) var(--ease-out-warm)" }}
                            />
                          </svg>
                        );
                      })()}
                    </button>
                  )}
                />
                <Popover.Portal>
                  <Popover.Positioner side="top" align="end" sideOffset={8}>
                    <Popover.Popup className="composer-menu composer-popover">
                      <Popover.Title className="composer-popover-title">{t("chatInput.contextUsageTitle")}</Popover.Title>
                      <Popover.Description className="composer-popover-stats">
                        {contextUsage && contextUsage.tokens != null && contextUsage.contextWindow > 0
                          ? t("chatInput.contextTokens", {
                              tokens: formatTokenCount(contextUsage.tokens, locale),
                              window: formatTokenCount(contextUsage.contextWindow, locale),
                            })
                          : t("chatInput.contextEmpty")}
                        {contextUsage && contextUsage.percent != null && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)" }}>
                            {t("chatInput.contextPercent", { percent: Math.round(contextUsage.percent) })}
                          </span>
                        )}
                      </Popover.Description>
                      {onCompact && (
                        <button
                          type="button"
                          className="composer-compact-action"
                          onClick={isCompacting ? onAbortCompaction : onCompact}
                          disabled={isStreaming && !isCompacting}
                          title={isCompacting ? t("chatInput.stopCompaction") : t("chatInput.compactContext")}
                        >
                          {isCompacting ? (
                            <>
                              <span className="composer-compact-spinner" aria-hidden="true" />
                              {t("chatInput.compacting")}
                            </>
                          ) : (
                            <>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M4 14h6v6" />
                                <path d="M20 10h-6V4" />
                                <path d="M14 10 21 3" />
                                <path d="M3 21l7-7" />
                              </svg>
                              {t("chatInput.compactContext")}
                            </>
                          )}
                        </button>
                      )}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}

            {/* Model selector — text-only, primary tone */}
            {!dictationActive && (modelOptions.length > 0 || currentName || modelError || showModelsLoading) && onModelChange && (
              <div ref={dropdownRef} style={{ position: "relative", minWidth: 0, flex: "0 1 auto", maxWidth: 190 }}>
                <button
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setModelDropdownOpen((v) => !v);
                  }}
                  disabled={modelSelectorDisabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28,
                    maxWidth: "100%",
                    padding: "0 0 0 8px",
                    overflow: "hidden",
                    background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: "var(--text)",
                    cursor: modelSelectorDisabled ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontFamily: "inherit",
                    fontWeight: 500,
                    opacity: modelSelectorDisabled ? 0.5 : 1,
                    transition: "background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => {
                    if (modelSelectorDisabled) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                  }}
                  title={modelOptions.length > 0
                    ? t("chatInput.changeModel")
                    : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                  aria-expanded={modelDropdownOpen}
                  aria-haspopup="dialog"
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {currentName ?? (modelOptions.length > 0
                      ? t("chatInput.selectModel")
                      : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noModels"))}
                  </span>
                </button>
                {modelDropdownOpen && modelDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - modelDropdownRect.top + 6;
                  const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                    : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width, maxWidth: "calc(100vw - 16px)" };
                  return (
                    <div ref={modelDropdownPanelRef} className="picker-panel" style={{
                      position: "fixed",
                      bottom,
                      ...panelPos,
                      zIndex: 500,
                      display: "flex", flexDirection: "column",
                      maxHeight: maxH,
                    }}>
                      <div className="picker-panel-header">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <rect x="9" y="9" width="6" height="6" />
                        </svg>
                        <span className="picker-panel-title">{t("chatInput.modelsLabel")}</span>
                        <span className="picker-panel-count">{modelOptions.length}</span>
                      </div>
                      <label className="picker-search">
                        <Search size={13} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
                        <input
                          ref={modelSearchInputRef}
                          type="search"
                          autoComplete="off"
                          spellCheck={false}
                          value={modelSearchQuery}
                          onChange={(e) => setModelSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setModelDropdownOpen(false);
                            }
                          }}
                          placeholder={t("chatInput.searchModels")}
                          aria-label={t("chatInput.searchModels")}
                        />
                      </label>
                      <div className="picker-list">
                        {modelsByProvider.length === 0 ? (
                          <div style={{ padding: "9px 8px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                            {modelSearchQuery.trim() ? t("chatInput.noMatchingModels") : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                          </div>
                        ) : modelsByProvider.map((group) => (
                          <div key={group.provider}>
                            <div className="picker-group-label">{group.provider}</div>
                            {group.options.map((opt) => {
                              const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                              return (
                                <button
                                  className="picker-row"
                                  data-active={isActive}
                                  key={`${opt.provider}:${opt.modelId}`}
                                  onClick={() => { setModelDropdownOpen(false); if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId); }}
                                >
                                  <span className="picker-check">
                                    {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                                  </span>
                                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.name}</span>
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Thinking selector — text-only, distinct softer tone */}
            {!dictationActive && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative", flexShrink: 0 }}>
                <button
                  onClick={() => setThinkingDropdownOpen((v) => !v)}
                  title={t("chatInput.changeReasoningTitle", { level: thinkingDisplayLabel })}
                  aria-label={`${t("chatInput.changeReasoning")}: ${thinkingDisplayLabel}`}
                  aria-expanded={thinkingDropdownOpen}
                  aria-haspopup="menu"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28, padding: "0 8px 0 0", background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none", borderRadius: 7, color: "var(--text-muted)", cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "inherit", fontWeight: 500,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <span style={{ whiteSpace: "nowrap", textTransform: "capitalize" }}>{thinkingDisplayLabel}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div
                    className="picker-panel"
                    role="menu"
                    style={{
                      position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                      zIndex: 100, width: 190, maxWidth: "calc(100vw - 32px)",
                    }}
                  >
                    <div className="picker-panel-header">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
                        <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                        <line x1="7" y1="18" x2="12" y2="18" />
                      </svg>
                      <span className="picker-panel-title">{t("chatInput.reasoningLabel")}</span>
                      <span className="picker-panel-count">{thinkingLevelOptions.length}</span>
                    </div>
                    <div className="picker-thinking-cards">
                      {thinkingLevelOptions.map((lvl) => {
                        const isActive = (thinkingLevel ?? "auto") === lvl;
                        const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                        const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                        return (
                          <button
                            className="picker-thinking-card"
                            data-active={isActive}
                            role="menuitemradio"
                            aria-checked={isActive}
                            key={lvl}
                            onClick={() => { setThinkingDropdownOpen(false); if (!isActive && !isStreaming) onThinkingLevelChange(lvl); }}
                          >
                            <span className="picker-check">
                              {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                            </span>
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "capitalize" }}>{displayLabel}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="picker-panel-footer">
                      <span>{t("chatInput.appliesNextPrompt")}</span>
                      <span style={{ fontWeight: 600, color: "var(--text-muted)", textTransform: "capitalize" }}>{thinkingDisplayLabel}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="composer-dictation-slot" data-active={dictationActive ? "true" : "false"}>
              <DictationControl
                key={draftKey ?? cwd ?? "new"}
                sendLabel={t("chatInput.send")}
                onPreview={acceptPreview}
                onTranscript={(text, send) => {
                  setDictationPreview("");
                  setValue((current) => current + (current && !/\s$/.test(current) ? " " : "") + text);
                  if (send) setDictationSubmit(true);
                  textareaRef.current?.focus();
                }}
                onActiveChange={setDictationActive}
              />
            </div>

            {/* Primary action: round up-arrow Send (idle) / Send (typed or attached while
                running — stop+send) / Stop (running while empty). Stable
                far-right position. */}
            {!dictationActive && (submitting ? <button type="button" className="composer-send" disabled aria-label="Sending message" title="Sending message"><span className="composer-compact-spinner" aria-hidden="true" /></button> : isStreaming ? (
              value.trim() || attachedImages.length || attachedTextFiles.length ? (
                <button
                  type="button"
                  onClick={handleSend}
                  className="composer-send"
                  aria-label={t("chatInput.send")}
                  title={t("chatInput.steerNowTitle")}
                >
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="7" y1="12" x2="7" y2="3" />
                    <polyline points="2.5 7.5 7 3 11.5 7.5" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={isCompacting ? onAbortCompaction : onAbort}
                  className="composer-send"
                  aria-label={t("chatInput.stopAgent")}
                  title={t("chatInput.stopAgent")}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <rect x="1" y="1" width="8" height="8" rx="1.6" fill="currentColor" />
                  </svg>
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!value.trim() && !attachedImages.length && !attachedTextFiles.length}
                className="composer-send"
                aria-label={t("chatInput.send")}
                title={t("chatInput.send")}
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="7" y1="12" x2="7" y2="3" />
                  <polyline points="2.5 7.5 7 3 11.5 7.5" />
                </svg>
              </button>
            ))}
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
            {bashExcluded ? t("chatInput.shellLocal") : t("chatInput.shellToModel")}
          </div>
        )}


      </div>
    </div>
  );
}));
