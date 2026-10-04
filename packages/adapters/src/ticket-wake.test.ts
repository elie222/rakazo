import { describe, expect, it } from "vitest";
import type { TicketWakeTicket } from "./ticket-wake.js";
import {
  decideTicketWake,
  renderTicketWakePrompt,
  TICKET_REMINDER_MS,
  TICKET_WAKE_DEBOUNCE_MS,
} from "./ticket-wake.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

function decision(overrides: Partial<Parameters<typeof decideTicketWake>[0]> = {}) {
  return decideTicketWake({
    now: NOW,
    trigger: "periodic",
    tickets: [{ updatedAt: hoursAgo(1) }],
    lastCheckAt: hoursAgo(2),
    lastWakeAt: null,
    hasActiveRun: false,
    ...overrides,
  });
}

describe("decideTicketWake", () => {
  it("does nothing when the bot owns no actionable tickets", () => {
    expect(decision({ tickets: [] })).toEqual({ wake: false, reason: "no-tickets" });
  });

  it("does nothing while the bot already has an active run", () => {
    expect(decision({ hasActiveRun: true })).toEqual({ wake: false, reason: "active-run" });
  });

  it("wakes when a ticket changed since the last check", () => {
    expect(decision({ lastCheckAt: hoursAgo(3) })).toEqual({ wake: true, reason: "changed" });
  });

  it("ignores a change the bot made itself", () => {
    expect(
      decision({
        lastCheckAt: hoursAgo(3),
        tickets: [{ updatedAt: hoursAgo(1), updatedByBot: true }],
      }),
    ).toEqual({ wake: false, reason: "unchanged" });
  });

  it("still wakes for someone else's change next to the bot's own", () => {
    expect(
      decision({
        lastCheckAt: hoursAgo(3),
        tickets: [
          { updatedAt: hoursAgo(1), updatedByBot: true },
          { updatedAt: hoursAgo(2), updatedByBot: false },
        ],
      }),
    ).toEqual({ wake: true, reason: "changed" });
  });

  it("stays quiet when nothing changed and the oldest ticket is fresh", () => {
    expect(
      decision({ lastCheckAt: minutesAgo(10), tickets: [{ updatedAt: hoursAgo(1) }] }),
    ).toEqual({ wake: false, reason: "unchanged" });
  });

  it("reminds once the oldest actionable ticket has been idle past four hours", () => {
    expect(
      decision({ lastCheckAt: minutesAgo(10), tickets: [{ updatedAt: hoursAgo(5) }] }),
    ).toEqual({ wake: true, reason: "reminder" });
  });

  it("does not repeat the reminder inside the reminder window", () => {
    expect(
      decision({
        lastCheckAt: minutesAgo(10),
        tickets: [{ updatedAt: hoursAgo(5) }],
        lastWakeAt: hoursAgo(1),
      }),
    ).toEqual({ wake: false, reason: "unchanged" });
    expect(TICKET_REMINDER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("debounces wakes inside the window even for an event", () => {
    expect(
      decision({
        trigger: "event",
        lastWakeAt: minutesAgo(2),
      }),
    ).toEqual({ wake: false, reason: "debounced" });
    expect(TICKET_WAKE_DEBOUNCE_MS).toBe(10 * 60 * 1000);
  });

  it("wakes promptly on an event once the debounce has passed", () => {
    expect(
      decision({
        trigger: "event",
        lastWakeAt: minutesAgo(11),
        lastCheckAt: minutesAgo(1),
      }),
    ).toEqual({ wake: true, reason: "assigned" });
  });

  it("honors custom windows", () => {
    expect(
      decision({
        now: NOW,
        trigger: "periodic",
        tickets: [{ updatedAt: minutesAgo(30) }],
        lastCheckAt: minutesAgo(5),
        lastWakeAt: null,
        hasActiveRun: false,
        reminderMs: 10 * 60 * 1000,
      }),
    ).toEqual({ wake: true, reason: "reminder" });
  });
});

function ticket(overrides: Partial<TicketWakeTicket> = {}): TicketWakeTicket {
  return {
    id: "ticket-1",
    ref: "RAK-1",
    title: "Ship the board",
    status: "todo",
    priority: "high",
    updatedAt: hoursAgo(1),
    lastComment: null,
    ...overrides,
  };
}

describe("renderTicketWakePrompt", () => {
  it("lists the actionable tickets with priority and the last comment", () => {
    const prompt = renderTicketWakePrompt({
      botName: "Helper",
      reason: "assigned",
      tickets: [ticket({ lastComment: "Blocked on the API key" })],
    });
    expect(prompt).toContain("RAK-1");
    expect(prompt).toContain("[todo]");
    expect(prompt).toContain("priority: high");
    expect(prompt).toContain("last comment: Blocked on the API key");
    expect(prompt).toContain("ticket_comment");
    expect(prompt).toContain("ticket_move");
    expect(prompt).toContain("Only message the user");
  });

  it("escapes ticket data so a title cannot inject markup", () => {
    const prompt = renderTicketWakePrompt({
      botName: "Helper",
      reason: "changed",
      tickets: [ticket({ title: "<script>alert(1)</script>" })],
    });
    expect(prompt).not.toContain("<script>");
    expect(prompt).toContain("&lt;script&gt;");
  });
});
