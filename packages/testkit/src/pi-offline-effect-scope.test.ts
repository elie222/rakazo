import { PiAgentRuntime } from "@rakazo/adapters";
import { expect, it, vi } from "vitest";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { recordEffect, runScopedToolExecutionId } from "../../adapters/src/run-effects.js";
import { startModelEmulator } from "./model-emulator.js";

it("isolates independent subagent effects with identical wire IDs and reconciles a retry", async () => {
  const write = (content: string) => ({
    expect() {},
    response: {
      type: "tool" as const,
      id: "call_1",
      name: "write_file",
      arguments: { path: "fixture.txt", content },
    },
  });
  const done = {
    expect() {},
    response: { type: "text" as const, text: "Done." },
  };
  const model = await startModelEmulator({
    steps: [
      write("main"),
      done,
      write("child-a"),
      done,
      write("child-a"),
      done,
      write("child-b"),
      done,
    ],
  });
  const run = {
    id: "fixture-run",
    spaceId: "fixture-space",
    botId: "fixture-bot",
    threadId: "fixture-thread",
  };
  const effects = new Map<
    string,
    {
      id: string;
      runId: string;
      spaceId: string;
      status: string;
      result?: unknown;
    }
  >();
  const deps = {
    prisma: {
      externalEffect: {
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          effects.get(where.idempotencyKey) ?? null,
        findMany: async () => [],
        create: async ({
          data,
        }: {
          data: {
            runId: string;
            spaceId: string;
            idempotencyKey: string;
            status: string;
          };
        }) => {
          const effect = { ...data, id: `effect-${effects.size}` };
          effects.set(data.idempotencyKey, effect);
          return effect;
        },
      },
    },
    events: { append: vi.fn() },
  } as unknown as Parameters<typeof recordEffect>[0];
  const writes: string[] = [];
  const ids: string[] = [];
  const runtime = new PiAgentRuntime();
  try {
    for (const id of ["main", "child-a", "child-a", "child-b"]) {
      const current = { ...run, id };
      for await (const _event of runtime.run({
        botId: run.botId,
        threadId: run.threadId,
        runId: current.id,
        instructions: "Complete synthetic fixture.",
        prompt: "Write then ask both helpers to write.",
        history: [],
        tools: builtinAgentTools.filter((tool) => tool.name === "write_file"),
        model: { ...model.model, maxTokens: 256 },
        executeTool: async (name, args, executionId) => {
          expect(name).toBe("write_file");
          ids.push(executionId);
          const applied = await recordEffect(
            deps,
            current,
            name,
            runScopedToolExecutionId(current.id, executionId),
            args,
          );
          if (applied.duplicate) return applied.effect.result;
          writes.push(String(args.content));
          applied.effect.status = "completed";
          applied.effect.result = { written: String(args.content) };
          return applied.effect.result;
        },
      })) {
      }
    }
    model.assertComplete();
    expect(writes).toEqual(["main", "child-a", "child-b"]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
    expect(ids[1]).toBe(ids[2]);
    expect(ids.map((id) => JSON.parse(id)[2])).toEqual(["call_1", "call_1", "call_1", "call_1"]);
    expect(
      model.requests
        .flatMap((request) => request.messages.filter((message) => message.role === "tool"))
        .some((message) => message.tool_call_id === "call_1"),
    ).toBe(true);
  } finally {
    await runtime.abort(run.id);
    await model.close();
  }
}, 30000);
