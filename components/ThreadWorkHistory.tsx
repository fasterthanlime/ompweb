"use client";
import { useEffect, useState } from "react";
import type { ActiveGoal } from "@/lib/web-mode-state";
import type { TodoPhase } from "@/lib/pi-types";
import type { SubagentInfo } from "@/lib/subagent-types";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./ui/primitives";
import { TodoList } from "./TodoList";
import { SubagentsPanel } from "./ComposerPanels";
import { AddTask } from "./AddTask";
export function ThreadWorkHistory({ goal, phases, subagents, onSelectSubagent, onAddTask, onGoalAction }: { goal?: ActiveGoal | null; phases: TodoPhase[]; subagents: SubagentInfo[]; onSelectSubagent: (agent: SubagentInfo) => void; onAddTask: (text: string) => Promise<void>; onGoalAction: (action: "resume" | "clear") => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { const show = () => setOpen(true); window.addEventListener("nook:work-history", show); return () => window.removeEventListener("nook:work-history", show); }, []);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Tasks and history</DialogTitle><DialogClose />
    {goal && <section style={{ marginBottom: 16 }}><h3 style={{ fontSize: 14 }}>Goal · {goal.status}</h3><p>{goal.objective}</p><div style={{ display: "flex", gap: 12 }}>{([...(goal.status === "paused" ? ["resume" as const] : []), "clear" as const]).map(action => <button type="button" key={action} disabled={pending} onClick={async()=>{setPending(true);setError(null);try{await onGoalAction(action);}catch(cause){setError(String(cause));}finally{setPending(false);}}}>{action === "resume" ? "Resume goal" : "Clear goal"}</button>)}</div></section>}
    {error && <p role="alert">{error}</p>}
    <TodoList phases={phases} headerless open />
    <AddTask onAdd={onAddTask}/>
    <SubagentsPanel subagents={subagents} onSelectSubagent={agent=>{setOpen(false);onSelectSubagent(agent)}}/>
  </DialogContent></Dialog>;
}
