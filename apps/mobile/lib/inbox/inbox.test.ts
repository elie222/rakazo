import { describe, expect, it } from "vitest";
import { filterBots, formatThreadTime } from "./inbox.js";

const now = new Date(2026, 7, 13, 21, 53, 0);

describe("formatThreadTime", () => {
  it("shows a 24-hour clock for today", () => {
    expect(formatThreadTime(local(now, 0, 14, 44), now)).toBe("14:44");
  });

  it("shows the weekday within the past week", () => {
    expect(formatThreadTime(local(now, 2, 10, 0), now)).toBe("Tuesday");
  });

  it("shows a short date when older than a week", () => {
    expect(formatThreadTime(local(now, 20, 9, 0), now)).toBe("Jul 24");
  });

  it("returns nothing for an invalid timestamp", () => {
    expect(formatThreadTime("not-a-date", now)).toBe("");
  });
});

describe("filterBots", () => {
  const bots = [
    bot("seo", "SEO Bot", "tracking-pixel page"),
    bot("inbox", "Inbox Triage", "draft replies"),
  ];

  it("returns the full list when the query is empty", () => {
    expect(filterBots(bots, "  ")).toEqual(bots);
  });

  it("matches name or preview", () => {
    expect(filterBots(bots, "seo").map((item) => item.id)).toEqual(["seo"]);
    expect(filterBots(bots, "triage").map((item) => item.id)).toEqual(["inbox"]);
    expect(filterBots(bots, "PIXEL").map((item) => item.id)).toEqual(["seo"]);
  });
});

function local(base: Date, daysAgo: number, hours: number, minutes: number) {
  const date = new Date(base);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function bot(id: string, name: string, preview: string) {
  return {
    id,
    name,
    computerMode: "team" as const,
    preview,
    color: "#9B5CF6",
    notifyOnFinish: true,
    threadId: `thread-${id}`,
    status: "idle",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    updatedAt: now.toISOString(),
  };
}
