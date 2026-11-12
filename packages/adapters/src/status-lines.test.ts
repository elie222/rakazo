import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENING_STATUS_ROTATION_MS, startStatusLines } from "./run-status-lines.js";
import type { StatusLineWriter } from "./status-lines.js";
import { statusLinesFrom } from "./status-lines.js";

describe("statusLinesFrom", () => {
  it("keeps one clean status per line", () => {
    expect(
      statusLinesFrom(
        '1. Reading your question.\n- "Finding sources"\n\n• Comparing prices…\n<request>x</request>',
      ),
    ).toEqual(["Reading your question", "Finding sources", "Comparing prices…"]);
  });

  it("drops lines too long to be a status and redacts secrets", () => {
    expect(statusLinesFrom(`${"word ".repeat(20)}\nUsing sk-123`, ["sk-123"])).toEqual([
      "Using [redacted]",
    ]);
  });
});

describe("startStatusLines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function target(writer: StatusLineWriter, opening?: Promise<string[]>) {
    const shown: string[] = [];
    let held = false;
    return {
      shown,
      hold: () => {
        held = true;
      },
      target: {
        writer: Promise.resolve(writer),
        request: "How much is the plan?",
        opening: opening ?? writer.opening("How much is the plan?", new AbortController().signal),
        held: () => held,
        show: async (text: string) => {
          shown.push(text);
        },
      },
    };
  }

  it("rotates the opening statuses until a step takes over", async () => {
    const writer: StatusLineWriter = {
      opening: async () => ["Reading your question", "Looking up prices", "Comparing plans"],
      step: async () => "Opening the pricing page",
    };
    const t = target(writer);
    const live = startStatusLines(t.target);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual(["Reading your question"]);
    await vi.advanceTimersByTimeAsync(OPENING_STATUS_ROTATION_MS);
    expect(t.shown).toEqual(["Reading your question", "Looking up prices"]);
    live.step("Reading page: https://example.com/pricing");
    await vi.advanceTimersByTimeAsync(OPENING_STATUS_ROTATION_MS * 3);
    expect(t.shown).toEqual([
      "Reading your question",
      "Looking up prices",
      "Opening the pricing page",
    ]);
    live.close();
  });

  it("drops a status that arrives after something newer took the line", async () => {
    let finish: (line: string) => void = () => {};
    const writer: StatusLineWriter = {
      opening: async () => [],
      step: () => new Promise((resolve) => (finish = resolve)),
    };
    const t = target(writer);
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await vi.advanceTimersByTimeAsync(0);
    live.supersede();
    finish("Listing files");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual([]);
    live.close();
  });

  it("leaves the line to the bot's own note", async () => {
    const writer: StatusLineWriter = {
      opening: async () => ["Reading your question"],
      step: async () => undefined,
    };
    const t = target(writer);
    t.hold();
    startStatusLines(t.target);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual([]);
  });

  it("shows nothing once the run ended", async () => {
    let finish: (lines: string[]) => void = () => {};
    const opening = new Promise<string[]>((resolve) => (finish = resolve));
    const writer: StatusLineWriter = { opening: () => opening, step: async () => undefined };
    const t = target(writer, opening);
    startStatusLines(t.target).close();
    finish(["Reading your question"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual([]);
  });
});
