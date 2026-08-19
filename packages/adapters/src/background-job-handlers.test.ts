import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));

describe("createBackgroundJobHandlers", () => {
  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const handlers = createBackgroundJobHandlers({
      executor: {} as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      { prisma, runtime, jobs, deploymentModelKey: "openrouter-key" },
      "thread-1",
    );
  });
});
