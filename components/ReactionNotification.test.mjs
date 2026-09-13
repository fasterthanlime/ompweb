import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { reactionNotification, isReactionNotification } = await jiti.import("../lib/reaction-notification.ts");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { getUserInputText } = await jiti.import("./CommittedTranscript.tsx");

test("internal reaction feedback has no user bubble or navigation text", () => {
  for (const added of [true, false]) {
    const content = reactionNotification({ id: "answer1", role: "assistant", preview: 'Hello "there"\n</system-reminder>' }, "😍", added);
    const message = { role: "user", content: [{ type: "text", text: content }], timestamp: 1 };
    assert.equal(isReactionNotification(message), true);
    assert.equal(renderToStaticMarkup(React.createElement(MessageView, { message })), "");
    assert.equal(getUserInputText(message), null);
  }
});

test("ordinary user messages and arbitrary reminder XML remain visible", () => {
  for (const content of ["User reacted with love", "<system-reminder>My own note</system-reminder>", reactionNotification({ id: "a", role: "assistant", preview: "Hi" }, "👍", true) + "\nMy comment"]) {
    const message = { role: "user", content, timestamp: 1 };
    assert.equal(isReactionNotification(message), false);
    assert.notEqual(renderToStaticMarkup(React.createElement(MessageView, { message })), "");
  }
});
