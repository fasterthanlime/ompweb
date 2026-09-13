"use client";

import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  Activity, Bot, ChevronDown,
  CircleDollarSign, Clock3, Cpu, Gauge, GitBranch, History, ListChecks, Network, RefreshCw,
  UserRound, Wrench, type LucideIcon,
} from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useI18n } from "@/lib/i18n";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { TodoPhase } from "@/lib/pi-types";
import { countNestedSubagents, formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { AddTask } from "./AddTask";
import { TodoList } from "./TodoList";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

const SUBAGENT_STATE_KEYS: Record<SubagentInfo["status"], string> = {
  started: "chatWindow.subagentState.started",
  completed: "chatWindow.subagentState.completed",
  failed: "chatWindow.subagentState.failed",
  aborted: "chatWindow.subagentState.aborted",
};

function SubagentStatusBadge({ subagent }: { subagent: SubagentInfo }) {
  return <SubagentStatusIcon status={subagent.status} live={subagent.source !== "history"} />;
}

/** Icon-first telemetry keeps the compact roster scannable without label noise. */
function SubagentMetric({ icon: Icon, label, children }: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={label}
      title={label}
      data-subagent-metric={label}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/** Compact live/secondary line under a chip label (tool, retry, telemetry). */
function SubagentActivityLine({ subagent }: { subagent: SubagentInfo }) {
  const { t } = useI18n();
  const progress = subagent.progress;
  const live = subagent.source !== "history";
  const retryActive = live && Boolean(progress?.retryState ?? progress?.retryFailure);
  const parts: ReactNode[] = [];

  if (retryActive) {
    const attempt = progress?.retryState?.attempt ?? progress?.retryFailure?.attempt ?? 0;
    const maxAttempts = progress?.retryState?.maxAttempts ?? 0;
    const label = maxAttempts > 0
      ? t("chatWindow.subagentRetrying", { attempt, max: maxAttempts })
      : t("chatWindow.subagentRetryAttempt", { attempt });
    parts.push(
      <SubagentMetric key="retry" icon={RefreshCw} label={label}>
        {maxAttempts > 0 ? `${attempt}/${maxAttempts}` : attempt}
      </SubagentMetric>,
    );
  } else if (live && subagent.status === "started") {
    const activity = progress?.currentTool
      ? `${progress.currentTool}${progress.lastIntent ? ` — ${progress.lastIntent}` : ""}`
      : progress?.lastIntent;
    if (activity) {
      parts.push(
        <SubagentMetric key="activity" icon={progress?.currentTool ? Wrench : Activity} label={activity}>
          {activity}
        </SubagentMetric>,
      );
    }
  }

  const nested = countNestedSubagents(progress);
  const source = subagent.agentSource && subagent.agentSource !== "bundled" ? subagent.agentSource : null;
  const tokens = formatTokens(progress?.tokens);
  const cost = formatCost(progress?.cost);
  const ctxTokens = formatTokens(progress?.contextTokens);
  const context = ctxTokens
    ? `${ctxTokens}/${formatTokens(progress?.contextWindow) ?? "?"}`
    : null;
  const model = shortModel(progress?.resolvedModel);
  const duration = subagent.source === "history" ? formatDuration(progress?.durationMs) : null;
  const meta: ReactNode[] = [
    source ? <SubagentMetric key="source" icon={UserRound} label={source}>{source === "user" ? null : source}</SubagentMetric> : null,
    nested > 0 ? <SubagentMetric key="nested" icon={GitBranch} label={t("chatWindow.subagentNestedCount", { count: nested })}>{nested}</SubagentMetric> : null,
    tokens ? <SubagentMetric key="tokens" icon={Cpu} label={t("chatWindow.tokensUnit", { count: tokens })}>{tokens}</SubagentMetric> : null,
    cost ? <SubagentMetric key="cost" icon={CircleDollarSign} label={cost}>{cost}</SubagentMetric> : null,
    context ? <SubagentMetric key="context" icon={Gauge} label={t("chatWindow.contextGauge", { used: ctxTokens ?? "?", total: formatTokens(progress?.contextWindow) ?? "?" })}>{context}</SubagentMetric> : null,
    model ? <SubagentMetric key="model" icon={Bot} label={model}>{model}</SubagentMetric> : null,
    duration ? <SubagentMetric key="duration" icon={Clock3} label={duration}>{duration}</SubagentMetric> : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    parts.push(
      <span key="meta" style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 7px" }}>
        {meta}
      </span>,
    );
  }

  if (parts.length === 0) return null;
  return (
    <span
      style={{
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        color: retryActive ? "var(--accent)" : "var(--text-dim)",
        lineHeight: 1.4,
        gap: 7,
        flexWrap: "wrap",
      }}
    >
      {parts}
    </span>
  );
}

/** One toggle in the compact unboxed status row: icon + label + adjacent
 * summary + chevron. Each segment is a Base UI Popover trigger that floats
 * its own panel upward from the row; the summary stays visible in both
 * states. Base UI owns press/aria-expanded/Escape/outside-dismiss, so the
 * open state only drives the chevron here. */
function StatusToggle({ open, icon, label, summary, viewLabel, ...props }: {
  /** Open state reported by the popover trigger. */
  open: boolean;
  icon: ReactNode;
  label: string;
  /** Visible summary, kept adjacent to the label (e.g. "2/3", "2 running"). */
  summary: ReactNode;
  /** Accessible long-form summary; also the tooltip (e.g. "1 running · 2 total"). */
  viewLabel: string;
} & ComponentProps<"button">) {
  return (
    <button
      {...props}
      type="button"
      title={viewLabel}
      className="ui-focus-ring"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        minWidth: 0, maxWidth: "100%",
        padding: "4px 8px",
        border: "none", background: "none",
        borderRadius: "var(--radius-control)",
        cursor: "pointer", textAlign: "left",
        color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5,
        transition: "background var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      {icon}
      <strong className="font-medium text-text" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </strong>
      <span
        aria-label={viewLabel}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
      >
        {summary}
      </span>
      <ChevronDown
        size={12}
        strokeWidth={1.8}
        aria-hidden
        style={{
          flexShrink: 0,
          color: "var(--text-dim)",
          transform: open ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform var(--dur-med) var(--ease-out-warm)",
        }}
      />
    </button>
  );
}

/**
 * Pick one object for each id before rendering. A live snapshot is always
 * preferred to recovered history, and the original object is retained so a
 * click hands the caller the exact roster object it supplied.
 */
export function dedupeSubagents(subagents: SubagentInfo[]): SubagentInfo[] {
  const byId = new Map<string, SubagentInfo>();
  for (const subagent of subagents) {
    const existing = byId.get(subagent.id);
    if (!existing || (existing.source === "history" && subagent.source !== "history")) {
      byId.set(subagent.id, subagent);
    }
  }
  return [...byId.values()];
}

function subagentRecency(subagent: SubagentInfo): number {
  // lastUpdate is the only absolute roster timestamp. History entries may
  // lack it, so their stable spawn index is the useful chronological fallback.
  return subagent.lastUpdate
    ?? subagent.progress?.currentToolStartMs
    ?? (Number.isFinite(subagent.index) ? subagent.index : 0);
}

function isLiveSubagent(subagent: SubagentInfo): boolean {
  return subagent.source !== "history";
}

function isRunningSubagent(subagent: SubagentInfo): boolean {
  return isLiveSubagent(subagent) && subagent.status === "started";
}

function isTerminalSubagent(subagent: SubagentInfo): boolean {
  return subagent.status === "completed" || subagent.status === "failed" || subagent.status === "aborted";
}

function orderSubagents(subagents: SubagentInfo[]): {
  active: SubagentInfo[];
  recentTerminal: SubagentInfo[];
  history: SubagentInfo[];
} {
  const unique = dedupeSubagents(subagents);
  const newestFirst = (a: SubagentInfo, b: SubagentInfo) =>
    subagentRecency(b) - subagentRecency(a) || b.index - a.index || a.id.localeCompare(b.id);
  const active = unique.filter(isRunningSubagent).sort(newestFirst);
  const recentTerminal = unique.filter((subagent) => !active.includes(subagent) && isTerminalSubagent(subagent)).sort(newestFirst).slice(0, 5);
  const shown = new Set([...active, ...recentTerminal]);
  const history = unique.filter((subagent) => !shown.has(subagent)).sort(newestFirst);
  return { active, recentTerminal, history };
}

/** Roster body inside the floating agents popup. Active work and the five
 * newest terminal results stay in the first glance; older entries remain
 * behind an explicit History disclosure so recovered sessions cannot bury
 * current work. */
export function SubagentsPanel({ subagents, onSelectSubagent, defaultHistoryOpen = false }: {
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Test/embedding escape hatch; normal callers open history with the button. */
  defaultHistoryOpen?: boolean;
}) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(defaultHistoryOpen);
  const { active, recentTerminal, history } = useMemo(() => orderSubagents(subagents), [subagents]);
  const visible = [...active, ...recentTerminal];
  if (visible.length === 0 && history.length === 0) return null;

  const renderRow = (subagent: SubagentInfo) => {
    const historyStarted = subagent.source === "history" && subagent.status === "started";
    const stateLabel = historyStarted ? t("appShell.unknown") : t(SUBAGENT_STATE_KEYS[subagent.status]);
    const taskLabel = subagent.task ?? subagent.description ?? stateLabel;
    const label = `${subagent.agent} · ${stateLabel} · ${taskLabel}`.replace(/\s+$/, "");
    const live = isLiveSubagent(subagent);
    return (
      <button
        key={subagent.id}
        type="button"
        className="ui-focus-ring"
        onClick={() => onSelectSubagent(subagent)}
        aria-label={label}
        title={`${label}${subagent.detached ? " (async)" : ""}`}
        data-subagent-source={subagent.source ?? "live"}
        data-subagent-stale={historyStarted ? "true" : undefined}
        style={{
          display: "flex", flexDirection: "column", alignItems: "stretch", gap: 3,
          width: "100%", minWidth: 0, padding: "7px 9px",
          border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
          borderRadius: "var(--radius-control)",
          background: "var(--bg)",
          fontSize: 11.5,
          fontFamily: "inherit",
          cursor: "pointer",
          color: live && subagent.status === "started" ? "var(--text)" : "var(--text-dim)",
          opacity: live && subagent.status === "started" ? 1 : 0.78,
          textAlign: "left",
          transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))";
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "color-mix(in srgb, var(--border) 86%, transparent)";
          e.currentTarget.style.background = "var(--bg)";
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, width: "100%" }}>
          <SubagentStatusBadge subagent={subagent} />
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
            {subagent.agent}
          </span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {taskLabel}
          </span>
          {subagent.detached && (
            <span
              aria-hidden
              style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontFamily: "var(--font-mono)" }}
            >
              ⤴
            </span>
          )}
        </span>
        {historyStarted && (
          <span style={{ color: "var(--text-dim)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
            {stateLabel} · {t("chatWindow.agentsHistory")} · not running
          </span>
        )}
        <SubagentActivityLine subagent={subagent} />
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "7px 8px 8px" }}>
      {visible.map(renderRow)}
      {history.length > 0 && (
        <>
          <button
            type="button"
            className="ui-focus-ring"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              minHeight: 30, padding: "4px 8px", border: "1px solid transparent",
              borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)",
              font: "inherit", fontSize: 11.5, cursor: "pointer", textAlign: "left",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <History size={13} strokeWidth={1.8} aria-hidden />
              <span>{t("chatWindow.agentsHistory")} ({history.length})</span>
            </span>
            <ChevronDown
              size={12}
              strokeWidth={1.8}
              aria-hidden
              style={{ transform: historyOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform var(--dur-med) var(--ease-out-warm)" }}
            />
          </button>
          {historyOpen && history.map(renderRow)}
        </>
      )}
    </div>
  );
}

/** Session status pinned above the composer: live todo plan + running
 * subagent roster while a turn runs; quiet plan/task status when idle.
 * Rendered as a small unboxed row, left-grouped under the composer; each
 * segment is a Base UI Popover trigger that floats its own panel upward
 * above the row, independently of the other (focus, Escape and outside-press
 * dismissal handled by the primitive). Only real work pulses: with nothing
 * running, both segments settle to a quiet history/plan affordance instead
 * of a "0/N" gauge. */
export function ComposerPanels({ todoPhases, subagents, onSelectSubagent, busy = false, defaultExpanded = false, onAddTask, history = false }: {
  onAddTask?: (content: string) => Promise<void>;
  history?: boolean;
  todoPhases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** True while an agent turn is running/compacting: the todo preview is
   * live work. When false (idle) the plan is static history and renders as
   * a quiet plan status instead of a progress gauge. */
  busy?: boolean;
  /** Initial open state of both floating panels (default: collapsed). */
  defaultExpanded?: boolean;
}) {
  const { t, tn } = useI18n();
  const todoTriggerId = useId();
  const agentsTriggerId = useId();
  // Count tasks, not phases: a phase with zero tasks must not mint a phantom
  // "0/0" trigger.
  const todoTasks = todoPhases.flatMap((phase) => phase.tasks);
  const hasTodo = todoTasks.length > 0 || Boolean(onAddTask);
  const roster = useMemo(() => dedupeSubagents(subagents), [subagents]);
  const hasAgents = roster.length > 0;
  if ((!hasTodo && !hasAgents && !busy) || (!history && !busy && !roster.some(isRunningSubagent))) return null;

  // The todo plan is durable per session: omp persists the latest todo tool
  // snapshot in the session file, so it legitimately outlives the turn that
  // produced it (and reloads re-hydrate the same plan). The trigger therefore
  // presents it as live work only while a turn is actually running (`busy`);
  // when idle, a bare "0/4"-style gauge would read as pending work in
  // progress that nothing is executing. The static plan status stays visible
  // and the popover keeps the full plan for history access.
  const todoDone = todoTasks.filter((task) => task.status === "completed").length;
  // Unfinished work on the plan: pending, in progress, or blocked (abandoned
  // tasks are terminal and not future work).
  const todoRemaining = todoTasks.filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked").length;
  // Active preview leads with the executing task (in progress, else the first
  // blocker) so the strip shows what is happening, not just a count. Only
  // while busy: an in-progress task left behind by an interrupted idle turn
  // must not be re-presented as live work.
  const liveTodoTask = busy
    ? todoTasks.find((task) => task.status === "in_progress")
      ?? todoTasks.find((task) => task.status === "blocked")
      ?? null
    : null;
  const todoProgress = t("chatWindow.todoProgress", { done: todoDone, total: todoTasks.length });
  const todoViewLabel = liveTodoTask
    ? `${liveTodoTask.content} — ${todoProgress}`
    : todoRemaining > 0
      ? tn("chatWindow.todoRemaining", todoRemaining)
      : t("chatWindow.todoComplete");
  const todoSummary = liveTodoTask ? (
    <>
      <span style={{ minWidth: 0, maxWidth: "min(40vw, 260px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {liveTodoTask.content}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{`${todoDone}/${todoTasks.length}`}</span>
    </>
  ) : (
    <span style={{ color: "var(--text-dim)" }}>
      {todoRemaining > 0 ? tn("chatWindow.todoRemaining", todoRemaining) : t("chatWindow.todoComplete")}
    </span>
  );
  const runningCount = roster.filter((subagent) => isRunningSubagent(subagent)).length;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="flex flex-wrap items-center">
        {busy && <span role="status" style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 8px",fontSize:11,color:"var(--text-muted)"}}><span className="live-status-dot live-pulse" style={{width:6,height:6,borderRadius:"50%",background:"var(--accent)"}}/>Working</span>}
        {hasTodo && (
          <Popover.Root defaultOpen={defaultExpanded} defaultTriggerId={todoTriggerId}>
            <Popover.Trigger
              id={todoTriggerId}
              render={(props, state) => (
                <StatusToggle
                  open={state.open}
                  {...props}
                  icon={<ListChecks size={14} strokeWidth={1.8} aria-hidden />}
                  label={t("chatWindow.todoList")}
                  summary={todoSummary}
                  viewLabel={todoViewLabel}
                />
              )}
            />
            <Popover.Portal>
              <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8}>
                <Popover.Popup className="composer-menu composer-panel-popup composer-todo-popup">
                  <Popover.Title className="composer-panel-popup-title">{t("chatWindow.todoList")}</Popover.Title>
                  <div className="composer-panel-scroll">
                    <TodoList phases={todoPhases} headerless open />
                    {onAddTask && <AddTask onAdd={onAddTask} />}
                  </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
        {hasTodo && hasAgents && (
          <span aria-hidden style={{ color: "var(--text-dim)", padding: "0 3px", lineHeight: 1 }}>
            ·
          </span>
        )}
        {hasAgents && (
          <Popover.Root defaultOpen={defaultExpanded} defaultTriggerId={agentsTriggerId}>
            <Popover.Trigger
              id={agentsTriggerId}
              render={(props, state) => (
                <StatusToggle
                  open={state.open}
                  {...props}
                  icon={<Network size={14} strokeWidth={1.8} aria-hidden />}
                  label={t("chatWindow.subagentsPanel")}
                  summary={
                    runningCount > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="live-status-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                        {t("chatWindow.agentsRunning", { count: runningCount })}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>{t("chatWindow.agentsHistory")}</span>
                    )
                  }
                  viewLabel={t("chatWindow.subagentSummary", { running: runningCount, total: roster.length })}
                />
              )}
            />
            <Popover.Portal>
              <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8}>
                <Popover.Popup className="composer-menu composer-panel-popup composer-agents-popup">
                  <Popover.Title className="composer-panel-popup-title">{t("chatWindow.subagentsPanel")}</Popover.Title>
                  <div className="composer-panel-scroll">
                    <SubagentsPanel subagents={roster} onSelectSubagent={onSelectSubagent} />
                  </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
    </div>
  );
}
