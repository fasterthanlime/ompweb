"use client";

import { useEffect, useState } from "react";
import type { ActiveGoal } from "@/lib/web-mode-state";
import type { TodoPhase } from "@/lib/pi-types";
import type { SubagentInfo } from "@/lib/subagent-types";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./ui/primitives";
import { TodoList } from "./TodoList";
import { SubagentsPanel } from "./ComposerPanels";
import { AddTask } from "./AddTask";

interface ThreadWorkHistoryProps {
  goal?: ActiveGoal | null;
  phases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (agent: SubagentInfo) => void;
  onAddTask: (text: string) => Promise<void>;
  onGoalAction: (action: "resume" | "clear") => Promise<void>;
}

export function ThreadWorkHistory({ goal, phases, subagents, onSelectSubagent, onAddTask, onGoalAction }: ThreadWorkHistoryProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("nook:work-history", show);
    return () => window.removeEventListener("nook:work-history", show);
  }, []);

  async function changeGoal(action: "resume" | "clear") {
    setPending(true);
    setError(null);
    try {
      await onGoalAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function selectSubagent(agent: SubagentInfo) {
    setOpen(false);
    onSelectSubagent(agent);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Tasks and history</DialogTitle>
        <DialogClose />
        {goal && (
          <section style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14 }}>Goal · {goal.status}</h3>
            <p>{goal.objective}</p>
            <div style={{ display: "flex", gap: 12 }}>
              {goal.status === "paused" && (
                <button type="button" disabled={pending} onClick={() => void changeGoal("resume")}>Resume goal</button>
              )}
              <button type="button" disabled={pending} onClick={() => void changeGoal("clear")}>Clear goal</button>
            </div>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <TodoList phases={phases} headerless open />
        <AddTask onAdd={onAddTask} />
        <SubagentsPanel subagents={subagents} onSelectSubagent={selectSubagent} />
      </DialogContent>
    </Dialog>
  );
}
