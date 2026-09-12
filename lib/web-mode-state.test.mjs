import assert from "node:assert/strict";
import test from "node:test";
import { formatGoalElapsed, parseActiveGoal } from "./web-mode-state.ts";


test("goal state parser accepts only valid persisted goal records", () => {
  const goal = { id: "goal-1", objective: "Ship it", startedAt: 123, status: "blocked", summary: "Needs a decision" };
  assert.deepEqual(parseActiveGoal(goal), goal);
  assert.equal(parseActiveGoal({ ...goal, status: "unknown" }), null);
  assert.equal(parseActiveGoal({ ...goal, id: undefined }), null);
  assert.equal(parseActiveGoal('{"objective":"","startedAt":123}'), null);
  assert.equal(parseActiveGoal('{"objective":"Ship it","startedAt":"123"}'), null);
  assert.equal(parseActiveGoal("not JSON"), null);
});

test("goal elapsed formatter is stable at minute and hour boundaries", () => {
  assert.equal(formatGoalElapsed(-1), "0m");
  assert.equal(formatGoalElapsed(59_999), "0m");
  assert.equal(formatGoalElapsed(60_000), "1m");
  assert.equal(formatGoalElapsed(3_660_000), "1h 1m");
});
