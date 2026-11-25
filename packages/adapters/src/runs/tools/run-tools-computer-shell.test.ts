import type { ProcessEvent } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { computerTools } from "./run-tools-computer.js";

vi.mock("../../secrets/bot-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/bot-secrets.js")>()),
  shellCommandEnvironment: async () => ({ env: {}, unsetEnv: [], used: [] }),
}));

function shell(ctx: RunContext, call: ToolCall) {
  const handler = computerTools.shell;
  if (!handler) throw new Error("shell handler missing");
  return handler(ctx, call);
}

type Recorded = { status: string; exitCode: number | null; output: string };

function setup(stream: AsyncIterable<ProcessEvent>) {
  const events: Recorded[] = [];
  const ctx = {
    deps: {
      prisma: {},
      secretStore: {},
      events: {
        append: async ({ payload }: { payload: Recorded }) => {
          events.push({
            status: payload.status,
            exitCode: payload.exitCode,
            output: payload.output,
          });
        },
      },
      sandbox: { execute: () => stream },
    },
    run: { spaceId: "space-1" },
    runId: "run-1",
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    context: {},
    secrets: ["hunter2"],
    tools: { offered: [{ name: "shell" }, { name: "browser_snapshot" }] },
    computer: {
      mode: "personal",
      graphical: false,
      stored: { id: "computer-1", kind: "fake" },
      checkpoint: { markDirty: () => undefined },
      get: async () => ({ kind: "fake" }),
    },
  } as unknown as RunContext;
  const onShellStillRunning = vi.fn();
  const call = {
    name: "shell",
    args: { command: "echo hi" },
    executionId: "execution-1",
    observer: { onShellStillRunning },
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
  return { ctx, call, events, onShellStillRunning };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shell Activity events", () => {
  it("ends on done when the stream throws after output, with no later running", async () => {
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: "a\n" };
      yield { type: "stdout", data: "b\n" };
      throw new Error("connection lost");
    }
    const { ctx, call, events } = setup(stream());
    await expect(shell(ctx, call)).rejects.toThrow("connection lost");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.at(-1)).toEqual({ status: "done", exitCode: 1, output: "connection lost" });
    expect(events.filter((event) => event.status === "done")).toHaveLength(1);
  });

  it("appends done when a command that already returned as running then fails", async () => {
    const failure = deferred<never>();
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: "Open https://example.test and enter code ABCD-1234\n" };
      await failure.promise;
    }
    const { ctx, call, events, onShellStillRunning } = setup(stream());
    const pending = shell(ctx, call);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toMatchObject({ running: true, code: null });
    expect(events.at(-1)?.status).toBe("running");
    const completion = onShellStillRunning.mock.calls[0]?.[0] as Promise<unknown>;
    const settled = expect(completion).rejects.toThrow("timed out");
    failure.reject(new Error("timed out"));
    await settled;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.at(-1)).toEqual({ status: "done", exitCode: 1, output: "timed out" });
    expect(events.filter((event) => event.status === "done")).toHaveLength(1);
  });

  it("records running output and a final done when the command succeeds", async () => {
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: "hello\n" };
      yield { type: "exit", code: 0 };
    }
    const { ctx, call, events } = setup(stream());
    await expect(shell(ctx, call)).resolves.toMatchObject({ code: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.map((event) => event.status)).toEqual(["running", "running", "done"]);
    expect(events.at(-1)).toEqual({ status: "done", exitCode: 0, output: "hello\n" });
  });

  it("tells a command that found no display to open the bot's screen with an offered tool", async () => {
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stderr", data: "Error: Can't open display: \n" };
      yield { type: "exit", code: 1 };
    }
    const { ctx, call } = setup(stream());
    await expect(shell(ctx, call)).resolves.toMatchObject({
      code: 1,
      notice: expect.stringContaining("Call browser_snapshot to open it"),
    });
  });

  it("keeps the screen-opening notice when the display diagnostic was compacted out of large output", async () => {
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stderr", data: "h".repeat(70_000) };
      yield { type: "stderr", data: "\nError: Can't op" };
      yield { type: "stderr", data: "en display: :0\n" };
      yield { type: "stderr", data: "t".repeat(120_000) };
      yield { type: "exit", code: 1 };
    }
    const { ctx, call } = setup(stream());
    const result = (await shell(ctx, call)) as { code: number; stderr: string; notice?: string };
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("Can't open display");
    expect(result.notice).toContain("Call browser_snapshot to open it");
  });

  it("serializes live running writes so slow appends never pile up concurrently", async () => {
    const chunkGate = deferred();
    const slowWrite = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    const events: Recorded[] = [];
    let callIndex = 0;
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: "chunk-1\n" };
      await chunkGate.promise;
      yield { type: "stdout", data: "chunk-2\n" };
      yield { type: "stdout", data: "chunk-3\n" };
      yield { type: "exit", code: 0 };
    }
    const { ctx, call } = setup(stream());
    ctx.deps.events.append = (async ({ payload }: { payload: Recorded }) => {
      callIndex += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Hold the first live output write open while time advances and more chunks arrive.
        if (callIndex === 2) await slowWrite.promise;
        events.push({
          status: payload.status,
          exitCode: payload.exitCode,
          output: payload.output,
        });
      } finally {
        inFlight -= 1;
      }
    }) as unknown as RunContext["deps"]["events"]["append"];

    const running = shell(ctx, call);
    await vi.waitFor(() => expect(callIndex).toBe(2));
    // Advance well past the publish interval while the first live write is still in flight.
    await vi.advanceTimersByTimeAsync(5_000);
    chunkGate.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    // No second concurrent write should have started while write #2 is still in flight.
    expect(maxInFlight).toBe(1);
    expect(callIndex).toBe(2);

    slowWrite.resolve();
    await expect(running).resolves.toMatchObject({ code: 0 });
    expect(maxInFlight).toBe(1);
    expect(events.at(-1)).toEqual({
      status: "done",
      exitCode: 0,
      output: "chunk-1\nchunk-2\nchunk-3\n",
    });
  });

  it("cancels a queued stale snapshot when later clipped output returns to the last sent tail", async () => {
    const gate = deferred();
    const secondFillerGate = deferred();
    const exitGate = deferred();
    const slowWrite = deferred();
    const events: Recorded[] = [];
    let callIndex = 0;
    const filler = "a".repeat(16_000);
    async function* stream(): AsyncGenerator<ProcessEvent> {
      yield { type: "stdout", data: filler };
      await gate.promise;
      yield { type: "stdout", data: "B" };
      await secondFillerGate.promise;
      yield { type: "stdout", data: filler };
      await exitGate.promise;
      yield { type: "exit", code: 0 };
    }
    const { ctx, call } = setup(stream());
    ctx.deps.events.append = (async ({ payload }: { payload: Recorded }) => {
      callIndex += 1;
      if (callIndex === 2) await slowWrite.promise;
      events.push({
        status: payload.status,
        exitCode: payload.exitCode,
        output: payload.output,
      });
    }) as unknown as RunContext["deps"]["events"]["append"];

    const running = shell(ctx, call);
    await vi.waitFor(() => expect(callIndex).toBe(2));
    gate.resolve();
    // Queue the "B" snapshot while write #2 is still in flight.
    await vi.advanceTimersByTimeAsync(1_100);
    secondFillerGate.resolve();
    // Deliver the second filler so clipped output returns to lastSentOutput before write #2 settles.
    await vi.advanceTimersByTimeAsync(1_100);
    slowWrite.resolve();
    // Hold exit open and advance timers to confirm no stale "B" running write fires while still running.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callIndex).toBe(2);
    expect(events.some((event) => event.status === "running" && event.output.endsWith("B"))).toBe(
      false,
    );

    exitGate.resolve();
    await expect(running).resolves.toMatchObject({ code: 0 });
    expect(events.at(-1)?.status).toBe("done");
  });
});
