import { describe, expect, it } from "vitest";
import { statusChangeData, ticketChangeEvents } from "./board.js";

const before = {
  title: "Ship",
  description: "Do it",
  status: "todo",
  priority: null,
  assigneeBotId: "bot-1",
  acceptanceCriteria: [
    { text: "A", done: false },
    { text: "B", done: false },
  ],
};

describe("ticketChangeEvents", () => {
  it("produces nothing when nothing changed", () => {
    expect(ticketChangeEvents(before, { ...before })).toEqual([]);
    expect(ticketChangeEvents(before, { ...before, priority: "normal" })).toEqual([]);
  });

  it("records each changed field once", () => {
    const events = ticketChangeEvents(before, {
      ...before,
      title: "Ship it",
      status: "doing",
      assigneeBotId: "bot-2",
      priority: "high",
      description: "Do it now",
    });
    expect(events.map((event) => event.type)).toEqual([
      "title_changed",
      "description_changed",
      "status_changed",
      "assignee_changed",
      "priority_changed",
    ]);
    expect(events.find((event) => event.type === "status_changed")?.data).toEqual({
      from: "todo",
      to: "doing",
    });
  });

  it("tells a toggled criterion apart from an edited list", () => {
    const toggled = ticketChangeEvents(before, {
      ...before,
      acceptanceCriteria: [
        { text: "A", done: true },
        { text: "B", done: false },
      ],
    });
    expect(toggled).toEqual([{ type: "criterion_checked", data: { text: "A" } }]);

    const edited = ticketChangeEvents(before, {
      ...before,
      acceptanceCriteria: [{ text: "A", done: false }],
    });
    expect(edited.map((event) => event.type)).toEqual(["criteria_changed"]);
  });
});

describe("statusChangeData", () => {
  it("only stamps a real status change", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(statusChangeData("todo", "todo", now)).toEqual({});
    expect(statusChangeData("todo", "doing", now)).toEqual({ statusChangedAt: now });
  });
});
