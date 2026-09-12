export interface ActiveGoal {
  id: string;
  objective: string;
  startedAt: number;
  status: "active" | "paused" | "completed" | "blocked";
  summary?: string;
}

export interface ActivePlan {
  objective: string;
}

/** Old browser-only goals deliberately cannot become autonomous without consent. */
export function parseActiveGoal(value: unknown): ActiveGoal | null {
  if (!value || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  if (typeof goal.id !== "string" || !goal.id
    || typeof goal.objective !== "string" || !goal.objective.trim()
    || typeof goal.startedAt !== "number" || !Number.isFinite(goal.startedAt) || goal.startedAt < 0
    || !["active", "paused", "completed", "blocked"].includes(goal.status as string)
    || (goal.summary !== undefined && typeof goal.summary !== "string")) return null;
  return {
    id: goal.id, objective: goal.objective, startedAt: goal.startedAt,
    status: goal.status as ActiveGoal["status"],
    ...(typeof goal.summary === "string" ? { summary: goal.summary } : {}),
  };
}

/**
 * Guidance for the model is carried by native OMP host-tool definitions and
 * host-tool results, never by rewriting a user's visible prompt. Keep it
 * short: these are occasional interaction affordances, not a checklist.
 */
export const THREAD_INTERACTION_GUIDANCE = [
  "Keep interaction touches occasional and useful, not automatic every turn.",
  "React to a recent message when a brief acknowledgment is enough.",
  "Celebrate only a real milestone, not routine progress.",
  "Use show_visual for a concise explanatory diagram or visual when it improves understanding.",
  "Use set_expression for an occasional natural kaomoji and short caption; it is optional and never a substitute for required work.",
].join(" ");
const interactionReminderCounts = new Map<string, number>();

/**
 * Host-tool results are the only server-owned context injection point exposed
 * by the RPC contract. Every fourth server result gets a compact reminder;
 * ordinary results stay unchanged, and no user prompt or visible transcript
 * entry is rewritten.
 */
export function appendInteractionGuidance(sessionId: string, text: string): string {
  const count = (interactionReminderCounts.get(sessionId) ?? 0) + 1;
  interactionReminderCounts.set(sessionId, count);
  if (interactionReminderCounts.size > 256) {
    const oldest = interactionReminderCounts.keys().next().value;
    if (oldest !== undefined) interactionReminderCounts.delete(oldest);
  }
  return count % 4 === 0 ? `${text}\n\nInteraction note: ${THREAD_INTERACTION_GUIDANCE}` : text;
}

export type SetGoalAction = "start" | "replace" | "clear";

export interface SetGoalArguments {
  action: SetGoalAction;
  objective?: string;
  goalId?: string;
}

/** Parse the shared set_goal wire shape before applying local or remote policy. */
export function parseSetGoalArguments(value: unknown): SetGoalArguments {
  const args = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const action = args.action === undefined ? "start" : args.action;
  if (action !== "start" && action !== "replace" && action !== "clear") throw new Error("Unknown goal action.");
  if (args.objective !== undefined && typeof args.objective !== "string") throw new Error("Goal objective must be text.");
  if (args.goalId !== undefined && typeof args.goalId !== "string") throw new Error("Goal ID must be text.");
  return {
    action,
    ...(typeof args.objective === "string" ? { objective: args.objective.trim() } : {}),
    ...(typeof args.goalId === "string" ? { goalId: args.goalId } : {}),
  };
}

/**
 * Validate an agent-callable set_goal mutation. `start` keeps its historical
 * no-active-goal contract; `replace` is the explicit escape hatch for a new
 * user-requested scope and is valid only for the matching active goal. A
 * paused goal is deliberately never replaceable by an agent.
 */
export function validateSetGoalArguments(
  current: ActiveGoal | null,
  args: SetGoalArguments,
  { activeTurn }: { activeTurn: boolean },
): void {
  if (args.action === "clear") {
    if (!current || args.goalId !== current.id) throw new Error("No matching goal to clear.");
    if (current.status === "paused") throw new Error("The user paused this goal; only the user may clear or resume it.");
    return;
  }
  if (!args.objective) throw new Error("A non-empty goal objective is required.");
  if (args.action === "replace") {
    if (!current || args.goalId !== current.id) throw new Error("No matching active goal to replace.");
    if (current.status !== "active") throw new Error("Only an active goal may be replaced; a paused goal requires the user's resume or clear action.");
    if (!activeTurn) throw new Error("Goals can only be replaced during an active agent turn.");
    return;
  }
  if (current?.status === "active" || current?.status === "paused") throw new Error(`A ${current.status} goal already exists. Continue it, or ask the user to resume a paused goal.`);
  if (!activeTurn) throw new Error("Goals can only be created during an active agent turn.");
}

export function goalPrompt(goal: ActiveGoal): string {
  return `Continue working autonomously toward this goal:\n\n${goal.objective}\n\n${THREAD_INTERACTION_GUIDANCE} A verified unit or progress report is not a stopping point. Continue through the whole objective. When the entire goal is verified complete, call finish_goal with goalId ${JSON.stringify(goal.id)}, status "completed", and a concise evidence summary. If a genuine blocker requires human input and no independent work remains, call finish_goal with status "blocked" and explain the decision or prerequisite needed. Do not claim completion for partial work. If the user explicitly requests a new scope during this turn, call set_goal with action "replace", the current goalId ${JSON.stringify(goal.id)}, and the new objective; never replace a paused goal. Ordinary final replies do not stop this goal; the host will continue it. The user can pause it with Stop or /goal pause.`;
}

export const GOAL_TOOL = {
  name: "finish_goal",
  label: "Finish Goal",
  loadMode: "essential",
  description: "Mark the current autonomous session goal completed with evidence, or blocked when human input is required and no independent work remains. Use the goalId from the goal instruction. Does not interrupt the current response.",
  parameters: {
    type: "object",
    properties: {
      goalId: { type: "string" },
      status: { type: "string", enum: ["completed", "blocked"] },
      summary: { type: "string" },
    },
    required: ["goalId", "status", "summary"],
    additionalProperties: false,
  },
};

export const SET_GOAL_TOOL = {
  name: "set_goal",
  label: "Set Goal",
  loadMode: "essential",
  description: "Manage an autonomous goal within the user's requested scope. action start (default) requires objective and runs only during the current active turn without starting a competing turn. action replace requires the current active goalId plus a new objective and is only for an explicit user-requested scope change; it creates a successor without starting another turn. action clear requires the current goalId and removes that goal. Never replace or clear a paused goal from an agent turn, and never use a stale goalId. The start/replace result contains the goal ID and completion instructions.",
  parameters: {
    type: "object",
    properties: { action: { type: "string", enum: ["start", "replace", "clear"] }, objective: { type: "string", minLength: 1 }, goalId: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
};

export function formatGoalElapsed(elapsedMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
