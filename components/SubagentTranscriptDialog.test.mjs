import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TaskBlock, CompletionBlock, SubagentTranscriptMessages } = await jiti.import("./SubagentTranscriptDialog.tsx");
test("renders transcript messages with shared markdown and paired tool results", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentTranscriptMessages, {
    sessionId: null,
    messages: [
      { role: "user", content: "Inspect the file" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "demo.ts" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "line one\nline two" }] },
    ],
  }));
  assert.match(html, /Inspect the file/);
  assert.match(html, /read/);
  assert.doesNotMatch(html, />U</);
  assert.doesNotMatch(html, />R</);
});

test("does not clip long completion text", () => {
  const longText = `${"a".repeat(500)}END`;
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: longText,
    truncated: false,
  }));
  assert.match(html, /END/);
});

test("renders the task as markdown with its label", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.",
  }));
  assert.match(html, /Task/);
  assert.match(html, /Target/);
  assert.match(html, /Review the changes\./);
});

test("renders nothing for an empty task", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, { task: "" }));
  assert.equal(html, "");
});

test("renders plain-text completion with its label", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "Everything passes.",
    truncated: false,
  }));
  assert.match(html, /Result/);
  assert.match(html, /Everything passes\./);
  assert.doesNotMatch(html, /Output truncated/);
});

test("renders structured JSON completions as key/value rows", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"overall_correctness":"incorrect","explanation":"x"}',
    truncated: false,
  }));
  assert.match(html, /overall_correctness/);
  assert.match(html, />incorrect</);
  assert.match(html, /explanation/);
  assert.match(html, />x</);
});

test("renders single-value JSON completions with unescaped line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"report":"Line one\\nLine two"}',
    truncated: false,
  }));
  assert.match(html, /Line one\nLine two/);
  assert.doesNotMatch(html, /\\n/);
});

test("shows the truncation note when the output was capped", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "partial",
    truncated: true,
  }));
  assert.match(html, /Output truncated/);
});

test("shows an empty state when no completion exists yet", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: null,
    truncated: false,
  }));
  assert.match(html, /No output yet/);
});
