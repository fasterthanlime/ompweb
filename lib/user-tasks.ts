import type { RpcProcess } from "./omp/rpc-process";
import type { TodoPhase } from "./pi-types";
/** Native /todo append reads and mutates the current plan in one handler.
 * Never send a stale browser copy through set_todos. */
export async function appendUserTask(proc: Pick<RpcProcess, "sendCommand">, content: unknown): Promise<TodoPhase[]> {
  if (typeof content !== "string" || !content.trim() || content.length > 2000 || /[\r\n\x00]/.test(content)) throw new Error("Task must be a single line of 1–2000 characters");
  const quoted = '"' + content.trim().replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const result = await proc.sendCommand<{ agentInvoked?: boolean }>({ type: "prompt", message: `/todo append ${quoted}` });
  if (result?.agentInvoked !== false) throw new Error("Runtime did not acknowledge the task-only command");
  const state = await proc.sendCommand<{ todoPhases: TodoPhase[] }>({ type: "get_state" });
  return state.todoPhases;
}
