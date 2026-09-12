import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ComposerPanels, SubagentsPanel, dedupeSubagents } = await jiti.import("./ComposerPanels.tsx");

const noop = () => {};

test("renders nothing when there are no tasks or subagents", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [],
    onSelectSubagent: noop,
  })), "");
});

test("roster body is empty-safe and chips expose the full state label", () => {
  assert.equal(renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [],
    onSelectSubagent: noop,
  })), "");

  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{ id: "s1", agent: "scout", status: "completed", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
  }));
  assert.match(html, /scout · Done · Map the surface/);
});

test("floats todo and roster panels from compact popover triggers", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [
      { id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 },
      { id: "s2", agent: "worker", status: "completed", task: "Write the code", index: 1 },
    ],
    onSelectSubagent: noop,
    busy: true,
    defaultExpanded: true,
  }));

  // Compact triggers carry the labels, summaries and full accessible titles...
  assert.match(html, /Tasks/);
  assert.match(html, /Subagents/);
  assert.match(html, /aria-label="Wire panels — 0\/1 complete"/);
  assert.match(html, /aria-label="1 running · 2 total"/);
  assert.doesNotMatch(html, />1 running · 2 total</);
  // ...both panels open from the strip (aria-expanded + popup-open state)...
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-popup-open/);
  // ...but their bodies are portaled, never expanded in-flow (no displacement).
  assert.doesNotMatch(html, /Implementation/);
  assert.doesNotMatch(html, /scout/);
  assert.doesNotMatch(html, /Map the surface/);
});

test("panels start collapsed with live summary in their headers", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "pending" }] }],
    subagents: [{ id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
    busy: true,
  }));
  // Headers (with live counts) are visible...
  assert.match(html, /Tasks/);
  assert.match(html, /1 task remaining/);
  assert.match(html, /Subagents/);
  assert.match(html, /aria-label="1 running · 1 total"/);
  assert.doesNotMatch(html, />1 running · 1 total</);
  // ...but both panels start collapsed: toggle headers only, no content.
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Wire panels/);
  assert.doesNotMatch(html, /Map the surface/);
});

test("collapsed todo header surfaces the active task with a secondary count", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [],
    onSelectSubagent: noop,
    busy: true,
  }));
  // Summary leads with the active task; the count stays secondary. The full
  // task text is exposed via aria-label (the popover body is not mounted).
  assert.match(html, />Wire panels</);
  assert.match(html, /aria-label="Wire panels — 0\/1 complete"/);
  assert.doesNotMatch(html, /Implementation/);
});

test("collapsed todo falls back to the first blocked task when nothing is in progress", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [
      { content: "Blocked item", status: "blocked" },
      { content: "Queued item", status: "pending" },
    ] }],
    subagents: [],
    onSelectSubagent: noop,
    busy: true,
  }));
  assert.match(html, />Blocked item</);
  assert.match(html, /aria-label="Blocked item — 0\/2 complete"/);
  assert.doesNotMatch(html, />Queued item</);
});

test("live chips show current tool, telemetry, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      detached: true,
      progress: {
        currentTool: "read",
        lastIntent: "Inspect foo.ts",
        tokens: 2200,
        cost: 0.0041,
        contextTokens: 8000,
        contextWindow: 32000,
        resolvedModel: "provider/gpt-x:high",
      },
    }],
    onSelectSubagent: noop,
  }));

  assert.match(html, /Map the surface/);
  assert.match(html, /read — Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="2\.2k tok"/);
  assert.match(html, /data-subagent-metric="8k\/32k ctx"/);
  assert.match(html, /data-subagent-metric="gpt-x"/);
  assert.doesNotMatch(html, />2\.2k tok</);
  assert.doesNotMatch(html, />8k\/32k ctx</);
  assert.match(html, /⤴/);
});

test("retrying chips surface retry state instead of the activity line", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "worker",
      status: "started",
      task: "Write the code",
      index: 0,
      progress: { retryState: { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 1 } },
    }],
    onSelectSubagent: noop,
  }));
  assert.match(html, /data-subagent-metric="retrying 2\/5"/);
  assert.doesNotMatch(html, />retrying 2\/5</);
});

test("coexists with composer layout and keeps todo plan status accessible", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Checklist item 1", status: "pending" }, { content: "Checklist item 2", status: "completed" }] }],
    subagents: [],
    onSelectSubagent: noop,
  }));
  assert.match(html, /Tasks/);
  assert.match(html, /1 task remaining/);
});

test("idle plan renders a quiet remaining count, never a live 0/N gauge", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [
      { content: "Task A", status: "pending" },
      { content: "Task B", status: "pending" },
      { content: "Task C", status: "pending" },
      { content: "Task D", status: "pending" },
    ] }],
    subagents: [],
    onSelectSubagent: noop,
  }));
  // The persisted 4-task plan reads as a static plan status ("4 tasks
  // remaining"), not as pending work being executed ("Tasks 0/4").
  assert.match(html, />4 tasks remaining</);
  assert.doesNotMatch(html, />0\/4</);
  assert.doesNotMatch(html, />Task A</);
  assert.doesNotMatch(html, /0\/4 complete/);
});

test("idle plan never re-presents an interrupted in-progress task as live", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [],
    onSelectSubagent: noop,
  }));
  // Turn ended mid-task: the in-progress marker is stale, so the trigger
  // must not lead with the task text as if it were still executing.
  assert.doesNotMatch(html, />Wire panels</);
  assert.match(html, />1 task remaining</);
});

test("completed idle plan shows a quiet complete state", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [
      { content: "Done A", status: "completed" },
      { content: "Done B", status: "abandoned" },
    ] }],
    subagents: [],
    onSelectSubagent: noop,
  }));
  assert.match(html, />complete</);
  assert.doesNotMatch(html, />0\/2</);
});

test("history chips render terminal telemetry without pulsing state", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "completed",
      task: "Map the surface",
      index: 0,
      source: "history",
      progress: { status: "completed", tokens: 999000, cost: 1.23, durationMs: 360000, resolvedModel: "provider/gpt-5.6:medium" },
    }],
    onSelectSubagent: noop,
  }));
  assert.match(html, /Map the surface/);
  assert.match(html, /data-subagent-metric="999k tok"/);
  assert.match(html, /data-subagent-metric="6m"/);
  // History chips must not show the pulsing live dot.
  assert.doesNotMatch(html, /live-pulse/);
});

test("chips show agent source, nested count, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      agentSource: "user",
      detached: true,
      progress: {
        lastIntent: "Inspect foo.ts",
        inflightTaskDetails: { progress: [{ id: "g1", agent: "task" }, { id: "g2", agent: "task" }] },
      },
    }],
    onSelectSubagent: noop,
  }));
  assert.match(html, /Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="user"/);
  assert.match(html, /data-subagent-metric="2 nested"/);
  assert.match(html, /⤴/);
});

test("history chips mark detached async spawns", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Async audit",
      index: 0,
      source: "history",
      detached: true,
    }],
    onSelectSubagent: noop,
    defaultHistoryOpen: true,
  }));
  assert.match(html, /⤴/);
});


test("zero context tokens never print a null gauge", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      progress: { currentTool: "read", contextTokens: 0, contextWindow: 32000 },
    }],
    onSelectSubagent: noop,
  }));
  assert.doesNotMatch(html, /null/);
  assert.match(html, /read/);
});

test("dedupes by id with live roster entries preferred over history", () => {
  const history = { id: "same", agent: "scout", status: "completed", task: "Old result", index: 0, source: "history" };
  const live = { id: "same", agent: "scout", status: "started", task: "Current work", index: 1, source: "live" };
  const unique = dedupeSubagents([history, live]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0], live);
});

test("active work leads a large history and old rows stay behind History", () => {
  const oldHistory = Array.from({ length: 100 }, (_, index) => ({
    id: `history-${index}`,
    agent: "worker",
    status: "completed",
    task: `Historical task ${index}`,
    index,
    source: "history",
  }));
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{ id: "active", agent: "scout", status: "started", task: "Current task", index: 100, source: "live" }, ...oldHistory],
    onSelectSubagent: noop,
  }));
  assert.notEqual(html.indexOf("Current task"), -1);
  assert.equal(html.indexOf("Historical task 0"), -1);
});

test("history-started rows are explicitly unknown and not running when opened", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentsPanel, {
    subagents: [{ id: "stale", agent: "scout", status: "started", task: "Stale run", index: 0, source: "history" }],
    onSelectSubagent: noop,
    defaultHistoryOpen: true,
  }));
  assert.match(html, /data-subagent-stale="true"/);
  assert.match(html, /unknown/);
  assert.match(html, /not running/);
  assert.doesNotMatch(html, /live-pulse/);
});

