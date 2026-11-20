import { describe, expect, it } from "vitest";
import { topicSettledBy, topicTitle } from "./topics.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-20T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("topicTitle", () => {
  it("reads the first non-empty line as plain text", () => {
    expect(
      topicTitle({
        blocks: [{ kind: "text", text: "\n**#412 · Crash on launch**\nDetails follow." }],
      }),
    ).toBe("#412 · Crash on launch");
  });

  it("cuts a long first line", () => {
    const title = topicTitle({ blocks: [{ kind: "text", text: "word ".repeat(80) }] });
    expect(title.length).toBeLessThanOrEqual(120);
  });
});

describe("topicSettledBy", () => {
  it("keeps a marked topic done whatever its activity", () => {
    expect(topicSettledBy({ settledBy: "bot", unread: true, quietSince: now }, now)).toBe("bot");
    expect(topicSettledBy({ settledBy: "user", unread: false, quietSince: now }, now)).toBe("user");
  });

  it("settles a read topic after a quiet week", () => {
    expect(topicSettledBy({ settledBy: null, unread: false, quietSince: daysAgo(7) }, now)).toBe(
      "idle",
    );
    expect(
      topicSettledBy({ settledBy: null, unread: false, quietSince: daysAgo(6) }, now),
    ).toBeNull();
  });

  it("never settles a topic its viewer has not read", () => {
    expect(
      topicSettledBy({ settledBy: null, unread: true, quietSince: daysAgo(30) }, now),
    ).toBeNull();
  });
});
