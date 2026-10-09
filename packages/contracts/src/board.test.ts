import { describe, expect, it } from "vitest";
import {
  CreateTicketInput,
  GetTicketInput,
  isTicketCompletedStatus,
  parseTicketRef,
  reservedTicketNumber,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketSchema,
  ticketRef,
  UpdateTicketInput,
} from "./board.js";

describe("parseTicketRef", () => {
  it("parses a readable reference", () => {
    expect(parseTicketRef("RAK-42")).toEqual({ prefix: "RAK", number: 42 });
  });

  it("matches the prefix case-insensitively and normalizes it", () => {
    expect(parseTicketRef("rak-42")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("  RaK-7  ")).toEqual({ prefix: "RAK", number: 7 });
  });

  it("rejects a reference whose prefix differs from the board", () => {
    expect(parseTicketRef("RAK-42", "RAK")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("rak-42", "RAK")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("ABC-42", "RAK")).toBeNull();
  });

  it("rejects malformed references", () => {
    for (const value of ["RAK", "RAK-", "-42", "RAK 42", "RAK-0", "RAK-007", "42-RAK", ""]) {
      expect(parseTicketRef(value)).toBeNull();
    }
  });
});

describe("ticket numbering", () => {
  it("turns a post-increment counter into the reserved number", () => {
    expect(reservedTicketNumber(2)).toBe(1);
  });

  it("hands out distinct ascending numbers", () => {
    let nextNumber = 1;
    const reserved: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      nextNumber += 1;
      reserved.push(reservedTicketNumber(nextNumber));
    }
    expect(reserved).toEqual([1, 2, 3]);
    expect(new Set(reserved).size).toBe(reserved.length);
  });

  it("renders the reference from prefix and number", () => {
    expect(ticketRef("RAK", 42)).toBe("RAK-42");
  });
});

describe("ticket contracts", () => {
  const ticket = {
    id: "ticket-1",
    boardId: "board-1",
    spaceId: "space-1",
    number: 1,
    ref: "RAK-1",
    title: "Ship the board",
    description: null,
    status: "todo",
    priority: "normal",
    assigneeBotId: null,
    createdByBotId: null,
    createdByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };

  it("accepts a ticket document and rejects unknown statuses", () => {
    expect(TicketSchema.parse(ticket).status).toBe("todo");
    expect(TicketSchema.parse({ ...ticket, status: "closed" }).status).toBe("closed");
    expect(() => TicketSchema.parse({ ...ticket, status: "archived" })).toThrow();
  });

  it("orders statuses with closed last and treats done and closed as completed", () => {
    expect(TICKET_STATUSES).toEqual(["todo", "doing", "review", "blocked", "done", "closed"]);
    expect(isTicketCompletedStatus("done")).toBe(true);
    expect(isTicketCompletedStatus("closed")).toBe(true);
    expect(isTicketCompletedStatus("review")).toBe(false);
  });

  it("accepts an optional boardId on list and create", () => {
    expect(
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", boardId: "b2" }),
    ).toEqual({ title: "Ship", assigneeBotId: "bot-1", priority: "normal", boardId: "b2" });
    expect(() =>
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", boardId: 7 }),
    ).toThrow();
  });

  it("always creates tickets with a known priority and no caller-chosen status", () => {
    expect(CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1" })).toEqual({
      title: "Ship",
      assigneeBotId: "bot-1",
      priority: "normal",
    });
    expect(
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", priority: "urgent" })
        .priority,
    ).toBe("urgent");
    const withoutStatus = CreateTicketInput.parse({
      title: "Ship",
      assigneeBotId: "bot-1",
      status: "doing",
    } as never);
    expect(withoutStatus).not.toHaveProperty("status");
    expect(() =>
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", priority: "whenever" }),
    ).toThrow();
    expect(TICKET_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("requires exactly one of id or ref when fetching", () => {
    expect(GetTicketInput.parse({ ref: "RAK-1" })).toEqual({ ref: "RAK-1" });
    expect(GetTicketInput.parse({ id: "ticket-1" })).toEqual({ id: "ticket-1" });
    expect(() => GetTicketInput.parse({})).toThrow();
    expect(() => GetTicketInput.parse({ id: "ticket-1", ref: "RAK-1" })).toThrow();
  });

  it("requires an owner bot when creating a ticket", () => {
    expect(CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1" })).toEqual({
      title: "Ship",
      assigneeBotId: "bot-1",
      priority: "normal",
    });
    expect(() => CreateTicketInput.parse({ title: "Ship" })).toThrow();
  });

  it("changes the owner without allowing it to be cleared", () => {
    expect(UpdateTicketInput.parse({ id: "ticket-1", assigneeBotId: "bot-2" }).assigneeBotId).toBe(
      "bot-2",
    );
    expect(() => UpdateTicketInput.parse({ id: "ticket-1", assigneeBotId: null })).toThrow();
  });
});
