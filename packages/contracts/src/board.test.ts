import { describe, expect, it } from "vitest";
import {
  CreateTicketInput,
  checkTicketTransition,
  GetTicketInput,
  isTicketCompletedStatus,
  parseCriteria,
  parseTicketRef,
  reservedTicketNumber,
  resolveCriteria,
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
    acceptanceCriteria: [{ text: "Board renders", done: false }],
    statusChangedAt: "2026-01-01T00:00:00.000Z",
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

  it("trims acceptance criteria and rejects blank items", () => {
    expect(
      CreateTicketInput.parse({
        title: "Ship",
        assigneeBotId: "bot-1",
        acceptanceCriteria: ["  Works  "],
      }).acceptanceCriteria,
    ).toEqual(["Works"]);
    expect(() =>
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", acceptanceCriteria: [" "] }),
    ).toThrow();
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

describe("acceptance criteria helpers", () => {
  it("keeps checked state for unchanged text and resets new or edited items", () => {
    const existing = [
      { text: "Works", done: true },
      { text: "Documented", done: false },
    ];
    expect(resolveCriteria(["Works", "Documented", "Tested"], existing)).toEqual([
      { text: "Works", done: true },
      { text: "Documented", done: false },
      { text: "Tested", done: false },
    ]);
    expect(resolveCriteria([{ text: "Documented", done: true }], existing)).toEqual([
      { text: "Documented", done: true },
    ]);
  });

  it("keeps the state of a repeated text apart by position", () => {
    // The second box of a repeated text is checked. The first box keeps its own
    // state instead of borrowing the one of its twin.
    expect(
      resolveCriteria(
        ["Deploy", { text: "Deploy", done: true }],
        [
          { text: "Deploy", done: true },
          { text: "Deploy", done: false },
        ],
      ),
    ).toEqual([
      { text: "Deploy", done: true },
      { text: "Deploy", done: true },
    ]);
    // The first box of a repeated text is unchecked. The second one stays as it
    // was, and the row above it does not turn checked.
    expect(
      resolveCriteria(
        ["Deploy", { text: "Deploy", done: false }],
        [
          { text: "Deploy", done: false },
          { text: "Deploy", done: true },
        ],
      ),
    ).toEqual([
      { text: "Deploy", done: false },
      { text: "Deploy", done: false },
    ]);
  });

  it("reads legacy strings and drops malformed stored items", () => {
    expect(parseCriteria(["  A ", { text: "B", done: true }, 4, { text: " " }, null])).toEqual([
      { text: "A", done: false },
      { text: "B", done: true },
    ]);
    expect(parseCriteria("nope")).toEqual([]);
  });
});

describe("checkTicketTransition", () => {
  const open = [
    { text: "A", done: true },
    { text: "B", done: false },
  ];
  const base = { from: "doing", to: "review", criteria: open, hasAssignee: true } as const;

  it("asks for a reason to hand off with open criteria, and accepts one", () => {
    expect(checkTicketTransition(base)).toMatch(/1 acceptance criterion is not checked/);
    expect(checkTicketTransition({ ...base, reason: "Verified manually" })).toBeNull();
    expect(checkTicketTransition({ ...base, to: "done" })).not.toBeNull();
    expect(checkTicketTransition({ ...base, criteria: [{ text: "A", done: true }] })).toBeNull();
  });

  it("requires a reason for blocked and won't do, and an owner for doing", () => {
    expect(checkTicketTransition({ ...base, to: "blocked" })).toMatch(/blocked on/);
    expect(checkTicketTransition({ ...base, to: "blocked", reason: "API down" })).toBeNull();
    expect(checkTicketTransition({ ...base, to: "closed" })).toMatch(/will not be done/);
    expect(checkTicketTransition({ ...base, to: "closed", reason: "Dropped" })).toBeNull();
    expect(
      checkTicketTransition({ ...base, from: "todo", to: "doing", hasAssignee: false }),
    ).toMatch(/owner/);
  });

  it("never blocks moving back or staying put", () => {
    expect(checkTicketTransition({ ...base, from: "review", to: "doing" })).toBeNull();
    expect(checkTicketTransition({ ...base, from: "done", to: "todo" })).toBeNull();
    expect(checkTicketTransition({ ...base, from: "review", to: "review" })).toBeNull();
  });
});
