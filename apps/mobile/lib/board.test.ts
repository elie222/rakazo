import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { boardSections, ticketStatusLabel } from "./board";

const ticket = (id: string, status: TicketStatus): Ticket => ({
  id,
  boardId: "board-1",
  spaceId: "space-1",
  number: Number(id.replace(/\D/g, "")) || 1,
  ref: `RAK-${id}`,
  title: id,
  description: null,
  status,
  priority: "normal",
  assigneeBotId: null,
  createdByBotId: null,
  createdByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  completedAt: null,
});

describe("boardSections", () => {
  it("keeps the board's column order and drops empty columns", () => {
    const sections = boardSections([ticket("1", "done"), ticket("2", "todo")]);

    expect(sections.map((section) => section.status)).toEqual(["todo", "done"]);
    expect(sections[0]!.tickets.map((row) => row.id)).toEqual(["2"]);
  });

  it("keeps the order the list arrived in inside a column", () => {
    const sections = boardSections([ticket("1", "doing"), ticket("2", "doing")]);

    expect(sections[0]!.tickets.map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("has no sections for an empty board", () => {
    expect(boardSections([])).toEqual([]);
  });
});

describe("ticketStatusLabel", () => {
  it("names every status the way the board does", () => {
    const t = (message: string) => message;

    expect(ticketStatusLabel("todo", t)).toBe("To do");
    expect(ticketStatusLabel("doing", t)).toBe("In progress");
    expect(ticketStatusLabel("review", t)).toBe("In review");
    expect(ticketStatusLabel("blocked", t)).toBe("Blocked");
    expect(ticketStatusLabel("done", t)).toBe("Done");
    expect(ticketStatusLabel("closed", t)).toBe("Won't do");
  });
});
