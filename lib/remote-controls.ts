import type { ActiveGoal } from "./web-mode-state";
import type { ContextUsage, SessionStatsInfo, TodoPhase, TodoItem } from "./pi-types";
import type { RpcProcess } from "./omp/rpc-process";

export interface RemoteModel {
  provider: string;
  modelId: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinking?: { efforts?: string[] };
}

export interface RemoteControls {
  /** The model the remote omp process actually resolved, not a config guess. */
  model: RemoteModel | null;
  models: Array<{
    id: string;
    name: string;
    provider: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    thinking?: { efforts?: string[] };
  }>;
  thinkingLevel: string;
  contextUsage: ContextUsage | null;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  tokensPerSecond: number | null;
  todoPhases: TodoPhase[];
  systemPrompt: string;
  sessionStats: SessionStatsInfo | null;
  goal: ActiveGoal | null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readContextUsage(value: unknown): ContextUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const contextWindow = nonNegativeNumber(record.contextWindow);
  if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
  const tokens = record.tokens === null ? null : nonNegativeNumber(record.tokens);
  if (record.tokens !== null && tokens === undefined) return null;
  const percent = record.percent === null ? null : nonNegativeNumber(record.percent);
  if (record.percent !== null && percent === undefined) return null;
  return { contextWindow, tokens: tokens ?? null, percent: percent ?? null };
}

function readThinking(value: unknown): { efforts?: string[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rawEfforts = (value as Record<string, unknown>).efforts;
  if (!Array.isArray(rawEfforts)) return undefined;
  const efforts = rawEfforts.filter((entry): entry is string => typeof entry === "string");
  return efforts.length ? { efforts } : undefined;
}

function readModel(value: unknown): RemoteModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.provider !== "string" || !record.provider) return null;
  const model: RemoteModel = {
    modelId: record.id,
    provider: record.provider,
    name: typeof record.name === "string" && record.name ? record.name : record.id,
  };
  if (typeof record.reasoning === "boolean") model.reasoning = record.reasoning;
  const contextWindow = nonNegativeNumber(record.contextWindow);
  if (contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow;
  const maxTokens = nonNegativeNumber(record.maxTokens);
  if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) model.maxTokens = maxTokens;
  const thinking = readThinking(record.thinking);
  if (thinking) model.thinking = thinking;
  return model;
}

function readTodoPhases(value: unknown): TodoPhase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((phase): TodoPhase[] => {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
    const record = phase as Record<string, unknown>;
    if (typeof record.name !== "string" || !Array.isArray(record.tasks)) return [];
    const tasks = record.tasks.flatMap((task): TodoItem[] => {
      if (!task || typeof task !== "object" || Array.isArray(task)) return [];
      const candidate = task as Record<string, unknown>;
      if (typeof candidate.content !== "string" || !["pending", "in_progress", "completed", "blocked", "abandoned"].includes(candidate.status as string)) return [];
      return [{
        content: candidate.content,
        status: candidate.status as TodoItem["status"],
        ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
        ...(typeof candidate.blocker === "string" ? { blocker: candidate.blocker } : {}),
      }];
    });
    return [{ name: record.name, tasks, ...(typeof record.id === "string" ? { id: record.id } : {}) }];
  });
}

function readCatalogModel(value: unknown): RemoteControls["models"][number] | null {
  const model = readModel(value);
  if (!model) return null;
  return {
    id: model.modelId,
    provider: model.provider,
    name: model.name,
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
  };
}

function readStats(value: unknown, contextUsage: ContextUsage | null): SessionStatsInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const integer = (key: string): number | undefined => {
    const number = nonNegativeNumber(record[key]);
    return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
  };
  const userMessages = integer("userMessages");
  const assistantMessages = integer("assistantMessages");
  const toolCalls = integer("toolCalls");
  const toolResults = integer("toolResults");
  const totalMessages = integer("totalMessages");
  const cost = nonNegativeNumber(record.cost);
  const tokenRecord = record.tokens;
  if (userMessages === undefined || assistantMessages === undefined || toolCalls === undefined || toolResults === undefined || totalMessages === undefined || cost === undefined
    || !tokenRecord || typeof tokenRecord !== "object" || Array.isArray(tokenRecord)) return null;
  const tokenValues = tokenRecord as Record<string, unknown>;
  const token = (key: string): number | undefined => {
    const number = nonNegativeNumber(tokenValues[key]);
    return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
  };
  const input = token("input");
  const output = token("output");
  const cacheRead = token("cacheRead");
  const cacheWrite = token("cacheWrite");
  const total = token("total");
  const reasoning = token("reasoning");
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || total === undefined) return null;
  const premiumRequests = integer("premiumRequests");
  return {
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    sessionName: typeof record.sessionName === "string" ? record.sessionName : undefined,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: { input, output, cacheRead, cacheWrite, total, ...(reasoning === undefined ? {} : { reasoning }) },
    ...(premiumRequests === undefined ? {} : { premiumRequests }),
    cost,
    ...(contextUsage ? { contextUsage } : {}),
  };
}

/** Read remote values from omp itself. Never derive lifetime telemetry from the bounded transcript page. */
export async function readRemoteControls(proc: RpcProcess, goal: ActiveGoal | null = null): Promise<RemoteControls> {
  const state = await proc.sendCommand<Record<string, unknown>>({ type: "get_state" });
  const catalog = await proc.sendCommand<{ models?: unknown }>({ type: "get_available_models" });
  const contextUsage = readContextUsage(state.contextUsage);
  let sessionStats: SessionStatsInfo | null = null;
  // Stats are an optional command on older omp builds. A missing command is a
  // truthful null, never a page-local approximation.
  try {
    sessionStats = readStats(await proc.sendCommand({ type: "get_session_stats" }), contextUsage);
  } catch {
    sessionStats = null;
  }
  const rawModels = Array.isArray(catalog.models) ? catalog.models : [];
  const models = rawModels.map(readCatalogModel).filter((model): model is RemoteControls["models"][number] => model !== null);
  const model = readModel(state.model);
  const systemPrompt = Array.isArray(state.systemPrompt)
    ? state.systemPrompt.filter((part): part is string => typeof part === "string").join("\n\n")
    : typeof state.systemPrompt === "string" ? state.systemPrompt : "";
  const tokensPerSecond = typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond) ? state.tokensPerSecond : null;
  const todoPhases = readTodoPhases(state.todoPhases);
  return {
    model,
    models,
    thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : "off",
    contextUsage,
    isCompacting: state.isCompacting === true,
    autoCompactionEnabled: state.autoCompactionEnabled !== false,
    tokensPerSecond,
    todoPhases,
    systemPrompt,
    sessionStats,
    goal,
  };
}
