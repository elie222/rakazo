import { deferred, flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { startStatusLines } from "./run-status-lines.js";
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

  it("shows one opening status until a step takes over", async () => {
    const t = target({
      opening: async () => "Looking into the plan pricing",
      step: async () => "Opening the pricing page",
    });
    const live = startStatusLines(t.target);
    await flush();
    expect(t.shown).toEqual(["Looking into the plan pricing"]);
    // It does not rotate: nothing else shows while the run sets up.
    await flush();
    expect(t.shown).toEqual(["Looking into the plan pricing"]);
    live.step("Reading page: https://example.com/pricing");
    await flush();
    expect(t.shown).toEqual(["Looking into the plan pricing", "Opening the pricing page"]);
    live.close();
  });

  it("never requests the opening once a step came first", async () => {
    const opening = vi.fn(async () => "Looking into the plan pricing");
    const writer = deferred<StatusLineWriter | undefined>();
    const t = target(undefined);
    t.target.writer = writer.promise;
    const live = startStatusLines(t.target);
    live.supersede();
    writer.resolve({ opening, step: async () => undefined });
    await flush();
    expect(opening).not.toHaveBeenCalled();
    live.close();
  });

  it("shows statuses one at a time, so a slow write never lands after a newer one", async () => {
    const slow = deferred();
    const steps = ["Listing files", "Reading the ledger"];
    const t = target({ opening: async () => undefined, step: async () => steps.shift() }, (text) =>
      text === "Listing files" ? slow.promise : Promise.resolve(),
    );
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    live.step("Reading ledger.json");
    await flush();
    slow.resolve();
    await flush();
    // The first step's write finishes first; the newer step then shows over it.
    expect(t.shown).toEqual(["Listing files", "Reading the ledger"]);
    live.close();
  });

  it("shows a tool's own description when no status model answers", async () => {
    const t = target({ opening: async () => undefined, step: async () => undefined });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    expect(t.shown).toEqual(["Running: ls"]);
    live.close();
  });

  it("asks for no opening status on an attempt that resumes earlier work", async () => {
    const opening = vi.fn(async () => "Looking into the plan pricing");
    const t = target({ opening, step: async () => undefined });
    const live = startStatusLines({ ...t.target, opening: false });
    await flush();
    expect(opening).not.toHaveBeenCalled();
    expect(t.shown).toEqual([]);
    live.close();
  });

  it("drops a status that arrives after something newer took the line", async () => {
    const finish = deferred<string | undefined>();
    const t = target({
      opening: async () => undefined,
      step: () => finish.promise,
    });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    live.supersede();
    finish.resolve("Listing files");
    await flush();
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
    await flush();
    expect(openingSignal?.aborted).toBe(false);
    live.close();
    expect(openingSignal?.aborted).toBe(true);
    expect(t.shown).toEqual([]);
  });

  it("sends nothing to the status model before the run's credentials are registered", async () => {
    const opening = vi.fn(async () => "Reading your question");
    const ready = deferred();
    const t = target({ opening, step: async () => undefined });
    startStatusLines({ ...t.target, ready: ready.promise });
    await flush();
    expect(opening).not.toHaveBeenCalled();
    ready.resolve();
    await flush();
    expect(opening).toHaveBeenCalledOnce();
    expect(t.shown).toEqual(["Reading your question"]);
  });

  it("cancels the request for a step that a newer one replaced", async () => {
    const signals: AbortSignal[] = [];
    const t = target({
      opening: async () => undefined,
      step: (_request, _step, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    live.step("Reading ledger.json");
    await flush();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    live.supersede();
    expect(signals[1]?.aborted).toBe(true);
    live.close();
  });

  it("stops every pending request when the run aborts", async () => {
    let openingSignal: AbortSignal | undefined;
    const run = new AbortController();
    const t = target({
      opening: (_request, signal) => {
        openingSignal = signal;
        return new Promise(() => {});
      },
      step: async () => undefined,
    });
    const live = startStatusLines({ ...t.target, signal: run.signal });
    await flush();
    run.abort();
    expect(openingSignal?.aborted).toBe(true);
    expect(live.active()).toBe(false);
  });

  it("leaves the line to the bot's own note", async () => {
    const t = target({
      opening: async () => "Reading your question",
      step: async () => undefined,
    });
    t.hold();
    startStatusLines(t.target);
    await flush();
    expect(t.shown).toEqual([]);
  });

  it("is active while the status model is looked up and with one, until the run ends", async () => {
    const writer = deferred<StatusLineWriter | undefined>();
    const live = startStatusLines({
      writer: writer.promise,
      request: "",
      held: () => false,
      show: async () => {},
    });
    // An early step waits for the lookup instead of showing its technical line.
    expect(live.active()).toBe(true);
    writer.resolve({ opening: async () => undefined, step: async () => undefined });
    await flush();
    expect(live.active()).toBe(true);
    live.close();
    expect(live.active()).toBe(false);
  });

  it("words a step that started before the status model was known", async () => {
    const writer = deferred<StatusLineWriter | undefined>();
    const t = target(undefined);
    t.target.writer = writer.promise;
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    writer.resolve({ opening: async () => undefined, step: async () => "Listing files" });
    await flush();
    expect(t.shown).toEqual(["Listing files"]);
    live.close();
  });

  it("shows the current step's status again after the line was cleared", async () => {
    const t = target({ opening: async () => undefined, step: async () => "Listing files" });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    live.restore();
    await flush();
    expect(t.shown).toEqual(["Listing files", "Listing files"]);
    // A status from a step something newer replaced does not come back.
    live.supersede();
    live.restore();
    await flush();
    expect(t.shown).toHaveLength(2);
    live.close();
  });

  it("stays inactive without a status model", async () => {
    const live = startStatusLines(target(undefined).target);
    await flush();
    expect(live.active()).toBe(false);
  });
});
