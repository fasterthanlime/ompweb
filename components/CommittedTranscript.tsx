"use client";

import { stripInteractionReminder } from "@/lib/interaction-reminder-text";
import { isReactionNotification } from "@/lib/reaction-notification";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, CustomMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { MessageView } from "./MessageView";

import { TranscriptImages } from "./TranscriptImages";
import type { ImageContent } from "@/lib/types";
export interface ConversationMeta {
  toolResultsMap: Map<string, ToolResultMessage>;
  lastAnchorIdx: number;
  visibleRefIndexByMessage: Map<number, number>;
}

export function getUserInputText(message: AgentMessage): string | null {
  if (isReactionNotification(message)) return null;
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = stripInteractionReminder(message.content).trim();
    return text.length > 0 ? text : null;
  }
  const text = stripInteractionReminder(message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")).trim();
  return text.length > 0 ? text : null;
}

export function buildConversationMeta(messages: AgentMessage[]): ConversationMeta {
  const toolResultsMap = new Map<string, ToolResultMessage>();
  let lastAnchorIdx = -1;
  const visibleRefIndexByMessage = new Map<number, number>();
  let refIdx = 0;
  messages.forEach((message, index) => {
    if (message.role === "toolResult") toolResultsMap.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
    if (isGroupAnchor(message)) lastAnchorIdx = index;
    if (message.role === "user" || message.role === "assistant") visibleRefIndexByMessage.set(index, refIdx++);
  });
  return { toolResultsMap, lastAnchorIdx, visibleRefIndexByMessage };
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  return message.role === "custom";
}

// A user message normally anchors a turn. Compaction summaries are anchors too
// because the original user prompt may be dropped during compaction.
function isGroupAnchor(message: AgentMessage): boolean {
  if (isReactionNotification(message)) return false;
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, children }: { messageCount: number; toolCallCount: number; children: ReactNode }) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chatWindow.processDetails"), tn("chatWindow.messageCount", messageCount)];
  if (toolCallCount > 0) parts.push(tn("chatWindow.toolCallCount", toolCallCount));
  return (
    <div style={{ marginBottom: 6 }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="process-details-toggle" title={expanded ? t("chatWindow.collapseProcessDetails") : t("chatWindow.expandProcessDetails")}>
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} />
        <span className="process-details-label">{parts.join(" · ")}</span>
      </button>
      {expanded && <div style={{ marginTop: 3 }}>{children}</div>}
    </div>
  );
}

export interface CommittedTranscriptProps {
  messages: AgentMessage[];
  entryIds?: string[];
  conversationMeta?: ConversationMeta;
  messageRefs?: RefObject<(HTMLDivElement | null)[]>;
  isStreaming?: boolean;
  sessionBusy?: boolean;
  isNew?: boolean;
  forkingEntryId?: string | null;
  handleFork?: (entryId: string) => void;
  handleNavigate?: (entryId: string) => void;
  handleEditContent?: (content: string) => void;
  modelNames?: Record<string, string>;
  messageCwd?: string;
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
  toolCallsDefaultCollapsed?: boolean;
  visibleCount?: number;
  nearBottom?: boolean;
  sentinelRef?: RefObject<HTMLButtonElement | null>;
  historyHasMore?: boolean;
  historyLoading?: boolean;
  handleLoadMoreClick?: () => void;
  /** Offset into the full transcript for bounded remote pages. */
  messageIndexOffset?: number;
}

/**
 * Shared committed transcript grouping for local and remote conversations.
 * Remote callers can omit local fork/history props and provide a bounded-page
 * messageIndexOffset so reactions retain their absolute transcript identity.
 */
export const CommittedTranscript = memo(function CommittedTranscript({
  messages, entryIds, conversationMeta, messageRefs, isStreaming = false, sessionBusy = false, isNew = false, forkingEntryId,
  handleFork, handleNavigate, handleEditContent, modelNames = {}, messageCwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed = true, visibleCount = Number.POSITIVE_INFINITY, nearBottom = true, sentinelRef, historyHasMore = false, historyLoading = false,
  handleLoadMoreClick = () => {}, messageIndexOffset = 0,
}: CommittedTranscriptProps) {
  const { t } = useI18n();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const sectionIndexRef = useRef(-1);
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role=dialog], select, [contenteditable=true]")) return;
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value.length > 0) return;
      const root = transcriptRef.current;
      if (!root || !root.getClientRects().length) return;
      const sections = [...root.querySelectorAll<HTMLElement>("[data-conversation-section]")];
      if (!sections.length) return;
      const focused = sections.findIndex(section => section.contains(document.activeElement));
      const current = focused >= 0 ? focused : sectionIndexRef.current;
      const next = current < 0 ? (event.key === "ArrowDown" ? 0 : sections.length - 1) : Math.max(0, Math.min(sections.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault();
      event.stopPropagation();
      sectionIndexRef.current = next;
      sections[next].focus({ preventScroll: true });
      sections[next].scrollIntoView({ block: "start", behavior: "auto" });
    };
    document.addEventListener("keydown", navigate, true);
    return () => document.removeEventListener("keydown", navigate, true);
  }, []);
  const computedMeta = useMemo(() => buildConversationMeta(messages), [messages]);
  const { toolResultsMap, lastAnchorIdx, visibleRefIndexByMessage } = conversationMeta ?? computedMeta;
  const attachVisibleRef = (refIndex: number) => (el: HTMLDivElement | null) => {
    if (messageRefs) messageRefs.current[refIndex] = el;
  };
  const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
    const msg = options.messageOverride ?? messages[idx];
    if (isReactionNotification(msg)) return null;
    if (msg.role === "toolResult" && options.keyPrefix !== "process" && Array.isArray(msg.content)) {
      const images = msg.content.filter((block): block is ImageContent => block.type === "image");
      if (images.length) return <TranscriptImages key={`tool-images-${idx}`} images={images} sessionId={sessionId} />;
    }
    const entryId = entryIds?.[idx];
    const prevAssistantEntryId = msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant" ? entryIds?.[idx - 1] : undefined;
    const isVisible = msg.role === "user" || msg.role === "assistant";
    const currentRefIdx = visibleRefIndexByMessage.get(idx);
    const keyPrefix = options.keyPrefix ?? "message";
    let showTimestamp = false;
    if (msg.role === "user") {
      const previous = messages[idx - 1];
      const currentTime = "timestamp" in msg ? msg.timestamp : undefined;
      const previousTime = previous && "timestamp" in previous ? previous.timestamp : undefined;
      showTimestamp = idx === 0 || (typeof currentTime === "number" && typeof previousTime === "number" && currentTime - previousTime > 5 * 60_000);
    }
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const role = messages[j].role;
        if (role === "user") break;
        if (role === "assistant") { showTimestamp = false; break; }
      }
      if (showTimestamp && isStreaming && idx === messages.length - 1) showTimestamp = false;
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    const view = (
      <div key={`${keyPrefix}-content-${idx}`} data-conversation-section={isGroupAnchor(msg) ? "" : undefined} tabIndex={isGroupAnchor(msg) ? -1 : undefined} style={{ scrollMarginTop: 16 }}>
        <MessageView
          key={`${keyPrefix}-view-${idx}`}
          message={msg}
          toolResults={toolResultsMap}
          modelNames={modelNames}
          cwd={messageCwd}
          onOpenFile={onOpenFile}
          entryId={entryId}
          messageIndex={messageIndexOffset + idx}
          onFork={sessionBusy || isNew || !entryId || !handleFork || (idx === 0 && msg.role === "user") ? undefined : handleFork}
          forking={entryId ? forkingEntryId === entryId : false}
          onNavigate={sessionBusy || !entryId || !handleNavigate ? undefined : handleNavigate}
          prevAssistantEntryId={sessionBusy || !prevAssistantEntryId ? undefined : prevAssistantEntryId}
          onEditContent={handleEditContent}
          showTimestamp={showTimestamp}
          prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
          sessionId={sessionId}
          toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
        />
      </div>
    );
    if (!isVisible || options.attachRef === false || currentRefIdx === undefined || !messageRefs) return view;
    return <div key={`${keyPrefix}-${idx}`} ref={attachVisibleRef(currentRefIdx)}>{view}</div>;
  };

  const rendered: ReactNode[] = [];
  for (let idx = 0; idx < messages.length;) {
    const msg = messages[idx];
    if (!isGroupAnchor(msg)) { rendered.push(renderMessage(idx)); idx += 1; continue; }
    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;
    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    if (finalAssistantIdx === -1) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) rendered.push(renderMessage(renderIdx));
      idx = endIdx;
      continue;
    }
    const isLiveTail = (sessionBusy || isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
    if (isLiveTail || !hasFinalAssistantAnswer(messages[finalAssistantIdx])) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) rendered.push(renderMessage(renderIdx));
      idx = endIdx;
      continue;
    }
    rendered.push(renderMessage(userIdx));
    for (let commentaryIdx = userIdx + 1; commentaryIdx < finalAssistantIdx; commentaryIdx++) {
      const message = messages[commentaryIdx];
      if (message.role !== "assistant") continue;
      const prose = message.content.filter(block => block.type === "text" && block.text.trim());
      if (prose.length) rendered.push(renderMessage(commentaryIdx, { messageOverride: withAssistantBlocks(message, prose, { omitUsage: true }), showTimestamp: false, keyPrefix: "commentary" }));
    }
    const processIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) processIndices.push(processIdx);
    const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0 ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true }) : null;
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0 ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks) : null;
    const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
    if (finalAnswerMessage) rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
    const attachmentImages = messages.slice(userIdx + 1, endIdx).flatMap(message => message.role === "toolResult" && Array.isArray(message.content) ? message.content.filter((block): block is ImageContent => block.type === "image") : []);
    if (attachmentImages.length) rendered.push(<TranscriptImages key={`attachments-${userIdx}`} images={attachmentImages} sessionId={sessionId} />);
    if (processCount > 0) {
      const processRefIdx = visibleProcessIndices.map((processIdx) => visibleRefIndexByMessage.get(processIdx)).find((value): value is number => typeof value === "number") ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
      const processGroup = <ProcessDetailsGroup messageCount={processCount} toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}>
        {visibleProcessIndices.map((processIdx) => { const message = messages[processIdx]; return renderMessage(processIdx, { attachRef: false, keyPrefix: "process", messageOverride: message.role === "assistant" ? withAssistantBlocks(message, message.content.filter(block => block.type !== "text"), { omitUsage: true }) : message }); })}
        {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
      </ProcessDetailsGroup>;
      rendered.push(<div key={`process-group-${userIdx}-${finalAssistantIdx}`} ref={processRefIdx === undefined || !messageRefs ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}>{processGroup}</div>);
    }
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) rendered.push(renderMessage(renderIdx));
    idx = endIdx;
  }

  const anchorStartIndexRef = useRef<number | null>(null);
  const { startIndex, hasMore } = useMemo(() => {
    const total = rendered.length;
    const endAnchored = Math.max(0, total - visibleCount);
    if (nearBottom || anchorStartIndexRef.current === null) {
      anchorStartIndexRef.current = endAnchored;
      return { startIndex: endAnchored, hasMore: endAnchored > 0 };
    }
    const anchored = Math.min(anchorStartIndexRef.current, endAnchored);
    anchorStartIndexRef.current = anchored;
    return { startIndex: anchored, hasMore: anchored > 0 };
  }, [rendered.length, visibleCount, nearBottom]);
  const showHistorySentinel = hasMore || historyHasMore;
  return <div ref={transcriptRef}>
    {showHistorySentinel && <button ref={sentinelRef} type="button" onClick={handleLoadMoreClick} disabled={historyLoading} className="py-3 w-full text-center text-xs text-text-muted hover:text-text transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60">
      {historyLoading ? t("chatWindow.loadingSession") : hasMore ? t("chatWindow.scrollUpToLoad", { count: startIndex }) : t("chatWindow.scrollUpToLoad", { count: 0 })}
    </button>}
    {rendered.slice(startIndex)}
  </div>;
});
