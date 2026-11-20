import type { TopicSummary } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../i18n/i18n";
import { chatTargetInput, chatTargetKey } from "./thread-target";
import { replyCountLabel, splitTopics } from "./topics";

vi.mock("../api/api", () => ({ rpc: vi.fn() }));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: vi.fn() }));
vi.mock("../query/query", () => ({ rpcQuery: vi.fn() }));
vi.mock("../query/screen-query", () => ({ useScreenQuery: vi.fn() }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
afterEach(() => resetI18nForTests());

function topic(id: string, overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    id,
    rootMessageId: `m-${id}`,
    title: id,
    item: false,
    replyCount: 2,
    lastActivityAt: "2026-01-01T12:00:00.000Z",
    unread: false,
    settledBy: null,
    ...overrides,
  };
}

describe("topics", () => {
  it("lists open topics before settled ones, keeping the server's order in each", () => {
    const { open, done } = splitTopics([
      topic("a", { settledBy: "user" }),
      topic("b"),
      topic("c", { settledBy: "idle" }),
      topic("d"),
    ]);
    expect(open.map((entry) => entry.id)).toEqual(["b", "d"]);
    expect(done.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("counts one reply and many", () => {
    expect(replyCountLabel(1)).toBe("1 reply");
    expect(replyCountLabel(3)).toBe("3 replies");
  });
});

describe("chat target", () => {
  it("names a topic by its bot and topic, and keeps its state apart from the bot's chat", () => {
    expect(chatTargetInput({ botId: "b", topicId: "t" })).toEqual({ botId: "b", topicId: "t" });
    expect(chatTargetInput({ botId: "b" })).toEqual({ botId: "b" });
    expect(chatTargetInput({ groupId: "g" })).toEqual({ groupId: "g" });
    expect(chatTargetKey({ botId: "b", topicId: "t" })).toBe("t");
    expect(chatTargetKey({ botId: "b" })).toBe("b");
  });
});
