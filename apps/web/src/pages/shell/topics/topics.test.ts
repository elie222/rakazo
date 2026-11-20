import type { TopicSummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { splitTopics, topicsByRootMessage, unreadOpenTopicCount } from "./topics";

function topic(id: string, patch: Partial<TopicSummary> = {}): TopicSummary {
  return {
    id,
    rootMessageId: `m-${id}`,
    title: id,
    item: false,
    replyCount: 1,
    lastActivityAt: "2026-11-20T10:00:00.000Z",
    unread: false,
    settledBy: null,
    ...patch,
  };
}

describe("topicsByRootMessage", () => {
  it("joins topics to the message they reply to, leaving out ones nobody has replied to", () => {
    const replied = topic("a", { replyCount: 3 });
    const map = topicsByRootMessage([replied, topic("b", { replyCount: 0, item: true })]);
    expect([...map]).toEqual([["m-a", replied]]);
  });
});

describe("splitTopics", () => {
  it("lists open topics apart from settled ones, keeping their order", () => {
    const topics = [
      topic("a", { settledBy: "user" }),
      topic("b"),
      topic("c", { settledBy: "idle" }),
      topic("d"),
    ];
    const { open, done } = splitTopics(topics);
    expect(open.map((item) => item.id)).toEqual(["b", "d"]);
    expect(done.map((item) => item.id)).toEqual(["a", "c"]);
  });
});

describe("unreadOpenTopicCount", () => {
  it("counts unread topics that are still open", () => {
    expect(
      unreadOpenTopicCount([
        topic("a", { unread: true }),
        topic("b", { unread: true, settledBy: "bot" }),
        topic("c"),
      ]),
    ).toBe(1);
  });
});
