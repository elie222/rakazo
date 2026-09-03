import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));

describe("createBackgroundJobHandlers", () => {
  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createBackgroundJobHandlers({
      executor: {
        continueRun: vi.fn(async () => undefined),
      } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {} as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      messaging: {} as unknown as MessagingSurface,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(consoleError).toHaveBeenCalledWith("messaging.deliver enqueue error", enqueueError);
    consoleError.mockRestore();
  });

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
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
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
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
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
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
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
