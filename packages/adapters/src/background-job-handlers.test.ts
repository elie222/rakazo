import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));

describe("createBackgroundJobHandlers", () => {
  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memoryProviders,
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        runtime,
        jobs,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        resolveModel,
      },
      "thread-1",
    );
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", workspaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      apiKey: "deployment-key",
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", workspaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });
});
