import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { latestActivityThought } = await jiti.import("./live-activity.ts");

function assistant(thinking, extraContent = []) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      ...extraContent,
    ],
  };
}

function toolCall(toolName = "bash") {
  return {
    type: "toolCall",
    toolCallId: `${toolName}-1`,
    toolName,
    input: {},
  };
}

function user(content = "Continue") {
  return { role: "user", content };
}

function toolResult(toolName = "bash") {
  return {
    role: "toolResult",
    toolCallId: `${toolName}-1`,
    toolName,
    content: [{ type: "text", text: "done" }],
  };
}

test("extracts the latest double-star summary from an assistant thought", () => {
  const messages = [
    assistant("Inspecting the repository\n**Initial summary**\nChecking the caller\n**Latest summary**"),
  ];

  assert.equal(latestActivityThought(messages), "Latest summary");
});

test("retains the current turn thought when a tool result is the tail", () => {
  const messages = [
    assistant("**Keep this thought while the tool completes**", [toolCall()]),
    toolResult(),
  ];

  assert.equal(latestActivityThought(messages), "Keep this thought while the tool completes");
});

test("a streaming tool-only assistant does not erase the earlier thought", () => {
  const messages = [assistant("**Earlier thought remains active**")];
  const streaming = {
    role: "assistant",
    content: [toolCall("read")],
  };

  assert.equal(latestActivityThought(messages, streaming), "Earlier thought remains active");
});

test("a new user message prevents a stale thought from the prior turn", () => {
  const messages = [assistant("**Stale prior turn thought**"), user("Start a new task")];

  assert.equal(latestActivityThought(messages), null);
});

test("prefers the latest bold summary over trailing detail and removes its stars", () => {
  const messages = [
    assistant("Working through the change\n**Latest bold summary**\nAdditional internal detail"),
  ];

  const thought = latestActivityThought(messages);
  assert.equal(thought, "Latest bold summary");
  assert.equal(thought.includes("**"), false);
});
