import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, filterModelOptions } = await jiti.import("./ChatInput.tsx");
const { setDraft, clearDraft } = await jiti.import("@/lib/draft-store");

test("shows Send (stop+send) instead of Stop for typed text during a run", () => {
  const draftKey = "chat-input-queue-action-test";
  setDraft(draftKey, { value: "Continue after the current run", images: [], files: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onInterruptAndReply: async () => true,
        isStreaming: true,
        draftKey,
      }),
    );

    assert.match(html, /aria-label="(Send|chatInput\.send)"/);
    assert.match(html, /title="(Interrupt the current run and inject this message now|chatInput\.steerNowTitle)"/);
    assert.doesNotMatch(html, />(Queue|chatInput\.queue)</);
    assert.doesNotMatch(html, />(Stop agent|chatInput\.stopAgent)</);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
  assert.match(html, /title="(No available models|chatInput\.noAvailableModels)"/);
});


test("renders goal and planning indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { id: "goal-test", objective: "Ship the active goal bar", startedAt: 0, status: "blocked" },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
      onAdvisorChange() {},
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Goal blocked|chatInput\.goalBlocked)/);
  assert.doesNotMatch(html, /(Goal active|chatInput\.goalActive)/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
});

test("renders the context ring with real usage and a compact action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onCompact() {},
      contextUsage: { tokens: 149510, contextWindow: 1000000, percent: 14.951 },
      isStreaming: false,
    }),
  );

  assert.match(html, /aria-label="(Context usage|chatInput\.contextUsageTitle)"/);
  assert.match(html, /class="composer-ring-button"/);
  // Ring draws the real fraction (14.951% ≈ 15% used): Sunburst circle with a
  // dash offset; the labelled Compact action lives in the ring's popover.
  assert.match(html, /stroke-dasharray="50\.27"/);
  assert.match(html, /title="(15% used|chatInput\.contextPercent)"/);
});

test("hides the ring when there is no usage data and no compact action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
    }),
  );

  assert.doesNotMatch(html, /composer-ring-button/);
});

test("filters model options by display name, identifier, and provider", () => {
  const options = [
    { provider: "OpenAI", modelId: "gpt-5.2", name: "GPT-5.2" },
    { provider: "Anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];

  assert.deepEqual(filterModelOptions(options, "sonnet", "en"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "5.2", "en"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "OPENAI", "en"), [options[0]]);
  assert.equal(filterModelOptions(options, "   ", "en"), options);
});

test("renders single queued prompt in compact bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First follow-up task"],
        steering: [],
      },
    }),
  );

  assert.match(html, /First follow-up task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.match(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("renders multiple queued prompts with count and expand action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First task", "Second task"],
        steering: ["Priority steer"],
      },
    }),
  );

  assert.match(html, /\(3\)/);
  assert.match(html, />(Show all queued prompts|Show all|chatInput\.expandQueued)</);
  assert.match(html, /First task/);
});
