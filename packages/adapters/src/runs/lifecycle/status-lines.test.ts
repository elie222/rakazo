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
    return {
      shown,
      target: {
        writer: Promise.resolve(writer),
        request: "How much is the plan?",
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

  it("lets the reply write only after a status already being written has landed", async () => {
    const landing = deferred();
    const t = target(
      { opening: async () => undefined, step: async () => "Listing files" },
      () => landing.promise,
    );
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    let replyMayWrite = false;
    const superseding = live.supersede().then(() => {
      replyMayWrite = true;
    });
    await flush();
    expect(replyMayWrite).toBe(false);
    landing.resolve();
    await superseding;
    expect(t.shown).toEqual(["Listing files"]);
    // With nothing under way, the reply goes ahead at once.
    await live.supersede();
    live.close();
  });

  it("keeps a step's wording when the step shows again, without asking twice", async () => {
    const step = vi.fn(async (_request: string, line: string) =>
      line === "Searching: prices" ? "Comparing prices" : "Reading the ledger",
    );
    const t = target({ opening: async () => undefined, step });
    const live = startStatusLines(t.target);
    live.step("Searching: prices");
    await flush();
    live.step("Reading ledger.json");
    await flush();
    // The ledger read ends first, and the search that is still running shows again.
    live.step("Searching: prices");
    await flush();
    expect(step).toHaveBeenCalledTimes(2);
    expect(t.shown).toEqual(["Comparing prices", "Reading the ledger", "Comparing prices"]);
    live.close();
  });

  it("ends only once a status already being written has landed", async () => {
    const landing = deferred();
    const t = target(
      { opening: async () => undefined, step: async () => "Listing files" },
      () => landing.promise,
    );
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    await flush();
    let ended = false;
    const closing = live.close().then(() => {
      ended = true;
    });
    await flush();
    expect(ended).toBe(false);
    landing.resolve();
    await closing;
    expect(t.shown).toEqual(["Listing files"]);
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

  it("keeps the request before the newest step and cancels older ones", async () => {
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
    live.step("Reading ledger.json");
    live.step("Searching: prices");
    await flush();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    live.supersede();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    live.close();
  });

  it("shows a step's status that arrives after a quicker step started", async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    const answers = [first, second];
    const t = target({ opening: async () => undefined, step: () => answers.shift()!.promise });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    live.step("Reading ledger.json");
    first.resolve("Listing files");
    await flush();
    // The newer step has no status yet, so the line moves on with the earlier one.
    expect(t.shown).toEqual(["Listing files"]);
    second.resolve("Reading the ledger");
    await flush();
    expect(t.shown).toEqual(["Listing files", "Reading the ledger"]);
    live.close();
  });

  it("never shows an earlier step's status over a newer one", async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    const answers = [first, second];
    const t = target({ opening: async () => undefined, step: () => answers.shift()!.promise });
    const live = startStatusLines(t.target);
    live.step("Running: ls");
    live.step("Reading ledger.json");
    second.resolve("Reading the ledger");
    await flush();
    first.resolve("Listing files");
    await flush();
    expect(t.shown).toEqual(["Reading the ledger"]);
    live.close();
  });

  it("lets later statuses through when one write never finishes", async () => {
    // Each write's time limit, ended by the test instead of the clock.
    const limits: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const limit = new AbortController();
      limits.push(limit);
      return limit.signal;
    });
    try {
      const stuck = deferred();
      const steps = ["Listing files", "Reading the ledger"];
      const shown: string[] = [];
      const live = startStatusLines({
        writer: Promise.resolve({
          opening: async () => undefined,
          step: async () => steps.shift(),
        }),
        request: "",
        show: async (text) => {
          if (text === "Listing files") await stuck.promise;
          shown.push(text);
        },
      });
      live.step("Running: ls");
      await flush();
      live.step("Reading ledger.json");
      await flush();
      expect(shown).toEqual([]);
      limits[0]!.abort(new DOMException("The operation timed out.", "TimeoutError"));
      await flush();
      expect(shown).toEqual(["Reading the ledger"]);
      // The stuck write lands late, over the newer status, which then shows again.
      stuck.resolve();
      await flush();
      expect(shown).toEqual(["Reading the ledger", "Listing files", "Reading the ledger"]);
      live.close();
    } finally {
      timeout.mockRestore();
    }
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

  it("is active while the status model is looked up and with one, until the run ends", async () => {
    const writer = deferred<StatusLineWriter | undefined>();
    const live = startStatusLines({
      writer: writer.promise,
      request: "",
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
