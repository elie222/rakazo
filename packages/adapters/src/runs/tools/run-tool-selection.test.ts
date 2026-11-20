import { describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const names = (options: Partial<Parameters<typeof selectBuiltinToolsForRun>[0]>) =>
  selectBuiltinToolsForRun({
    trigger: "user",
    graphicalToolsAllowed: false,
    groupId: null,
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
    ...options,
  }).map((tool) => tool.name);

describe("thread tools", () => {
  it("offers post_item only in the bot's own chat, including routine and webhook runs", () => {
    expect(names({ threadKind: "chat" })).toContain("post_item");
    expect(names({ threadKind: "chat", trigger: "routine" })).toContain("post_item");
    expect(names({ threadKind: "chat", trigger: "webhook" })).toContain("post_item");
    expect(names({ threadKind: "topic" })).not.toContain("post_item");
    expect(names({ threadKind: "other" })).not.toContain("post_item");
    expect(names({ threadKind: "chat", messagingChannelRun: true })).not.toContain("post_item");
  });

  it("offers settle_thread only inside a thread", () => {
    expect(names({ threadKind: "topic" })).toContain("settle_thread");
    expect(names({ threadKind: "chat" })).not.toContain("settle_thread");
    expect(names({})).not.toContain("settle_thread");
  });
});
