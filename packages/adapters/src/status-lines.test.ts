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

  function target(writer: StatusLineWriter | undefined, show?: (text: string) => Promise<void>) {
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
        held: () => held,
        show: async (text: string) => {
          await show?.(text);
          shown.push(text);
        },
      },
    };
  }

  it("rotates the opening statuses until a step takes over", async () => {
    const t = target({
      opening: async () => ["Reading your question", "Looking up prices", "Comparing plans"],
      step: async () => "Opening the pricing page",
    });
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

  it("shows statuses one at a time, so a slow write never lands after a newer one", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const steps = ["Listing files", "Reading the ledger"];
    const t = target({ opening: async () => [], step: async () => steps.shift() }, (text) =>
      text === "Listing files" ? slow : Promise.resolve(),
    );
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await vi.advanceTimersByTimeAsync(0);
    live.step("Reading ledger.json");
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // The first step's write finishes first; the newer step then shows over it.
    expect(t.shown).toEqual(["Listing files", "Reading the ledger"]);
    live.close();
  });

  it("shows a tool's own description when no status model answers, but never the bot's text", async () => {
    const t = target({ opening: async () => [], step: async () => undefined });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await vi.advanceTimersByTimeAsync(0);
    live.step("I found two sources and will compare them now.", { fallback: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual(["Running: ls"]);
    live.close();
  });

  it("drops a status that arrives after something newer took the line", async () => {
    let finish: (line: string) => void = () => {};
    const t = target({
      opening: async () => [],
      step: () => new Promise((resolve) => (finish = resolve)),
    });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await vi.advanceTimersByTimeAsync(0);
    live.supersede();
    finish("Listing files");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual([]);
    live.close();
  });

  it("cancels the opening request when the run ends", async () => {
    let openingSignal: AbortSignal | undefined;
    const t = target({
      opening: (_request, signal) => {
        openingSignal = signal;
        return new Promise(() => {});
      },
      step: async () => undefined,
    });
    const live = startStatusLines(t.target);
    await vi.advanceTimersByTimeAsync(0);
    expect(openingSignal?.aborted).toBe(false);
    live.close();
    expect(openingSignal?.aborted).toBe(true);
    expect(t.shown).toEqual([]);
  });

  it("leaves the line to the bot's own note", async () => {
    const t = target({
      opening: async () => ["Reading your question"],
      step: async () => undefined,
    });
    t.hold();
    startStatusLines(t.target);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown).toEqual([]);
  });

  it("is active only once a status model is known, and until the run ends", async () => {
    let resolveWriter: (writer: StatusLineWriter | undefined) => void = () => {};
    const writer = new Promise<StatusLineWriter | undefined>(
      (resolve) => (resolveWriter = resolve),
    );
    const live = startStatusLines({ writer, request: "", held: () => false, show: async () => {} });
    expect(live.active()).toBe(false);
    resolveWriter({ opening: async () => [], step: async () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(live.active()).toBe(true);
    live.close();
    expect(live.active()).toBe(false);
  });

  it("stays inactive without a status model", async () => {
    const live = startStatusLines(target(undefined).target);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.active()).toBe(false);
  });
});
