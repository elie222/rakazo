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
});
