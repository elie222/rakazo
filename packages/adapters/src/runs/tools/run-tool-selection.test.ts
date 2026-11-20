import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  selectBuiltinToolsForRun,
  unavailableBuiltinToolReasons,
} from "./run-tool-selection.js";

const none: { name: string }[] = [];

describe("unavailableBuiltinToolReasons", () => {
  it("explains a group thread's missing message_bot and points to handoff_to_bot", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: "g", trigger: "user" }, [
      { name: "handoff_to_bot" },
    ]);

    expect(reasons.message_bot).toBe(
      "message_bot is not available in group threads. Use handoff_to_bot with the group_id and the member's bot_id instead.",
    );
  });

  it("does not point to handoff_to_bot when the run was not offered it", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: "g", trigger: "user" }, none);

    expect(reasons.message_bot).toBe("message_bot is not available in group threads.");
  });

  it("explains a creation intro's missing tools and keeps ask_user and update_bot out of it", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: null, trigger: "created" }, none);

    expect(reasons.message_user).toBe(
      "message_user is not available until the user says what this bot is for. Use ask_user.",
    );
    expect(reasons).not.toHaveProperty("ask_user");
    expect(reasons).not.toHaveProperty("update_bot");
  });

  it("explains a background run's dropped messaging and media tools", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: null, trigger: "tickets" }, none);

    expect(reasons.message_bot).toBe(
      "message_bot is not available in a background run. Report through ticket_comment instead.",
    );
    expect(reasons.generate_image).toBe(
      "generate_image is not available in a background run. Report through ticket_comment instead.",
    );
  });

  it("explains a tool the bot turned off", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["message_user"] },
      none,
    );

    expect(reasons.message_user).toBe("message_user is turned off for this bot.");
  });

  it("gives a creation intro's disabled tool the creation reason first", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "created", disabledBuiltinTools: ["message_user"] },
      none,
    );

    expect(reasons.message_user).toBe(
      "message_user is not available until the user says what this bot is for. Use ask_user.",
    );
  });

  it("gives no reason to a tool that was offered", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: "g", trigger: "tickets", disabledBuiltinTools: ["message_user"] },
      [{ name: "message_bot" }, { name: "message_user" }],
    );

    expect(reasons).not.toHaveProperty("message_bot");
    expect(reasons).not.toHaveProperty("message_user");
  });

  it("gives no reason to a name that is not a built-in", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: "g", trigger: "tickets", disabledBuiltinTools: ["not_a_tool"] },
      none,
    );

    expect(reasons).not.toHaveProperty("not_a_tool");
    for (const name of Object.keys(reasons)) expect(BUILTIN_AGENT_TOOL_NAMES.has(name)).toBe(true);
  });
});

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
