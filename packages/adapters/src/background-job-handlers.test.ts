import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
  createRunExecutor,
  redactedToolReasoningStep,
  selectProviderCredential,
} from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));

describe("createBackgroundJobHandlers", () => {
  it("never crosses a default credential into a different requested provider", () => {
    const defaultCredential = { provider: "provider-a", secretId: "secret-a" };
    const requestedCredential = { provider: "provider-b", secretId: "secret-b" };

    expect(selectProviderCredential(undefined, defaultCredential, null)).toBe(defaultCredential);
    expect(selectProviderCredential("provider-b", defaultCredential, requestedCredential)).toBe(
      requestedCredential,
    );
    expect(selectProviderCredential("provider-b", defaultCredential, null)).toBeNull();
  });

  it("redacts tool arguments before they enter live or durable reasoning traces", () => {
    const step = redactedToolReasoningStep(
      {
        name: "shell",
        args: { command: "curl -H 'Authorization: Bearer fake-sensitive-key' example.test" },
        executionId: "tool-1",
      },
      ["fake-sensitive-key"],
    );

    expect(JSON.stringify(step)).not.toContain("fake-sensitive-key");
    expect(JSON.stringify(step)).toContain("[redacted]");
  });

  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
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
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      { prisma, runtime, jobs, deploymentModelKey: "openrouter-key", resolveModel },
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
      allowPrivateNetwork: false,
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
      allowPrivateNetwork: false,
      oauth: undefined,
    });
  });

  it("resolves a custom background model with its own URL and never substitutes the deployment key", async () => {
    const secretStore = new EncryptedSecretStore("fake-test-encryption-key");
    const stored = await secretStore.put("fake-custom-gateway-key", {
      operationId: "test",
      traceId: "test",
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    const credential = {
      id: "credential-1",
      secretId: "secret-1",
      provider: "gateway:fake",
      defaultModel: "fake/model",
      baseUrl: "http://127.0.0.1:11434/v1",
    };
    const findSecret = vi.fn(
      async (): Promise<{ id: string; ciphertext: string } | null> => ({
        id: "secret-1",
        ciphertext: stored.ciphertext,
      }),
    );
    const prisma = {
      userModelCredential: {
        findFirst: vi.fn(async () => credential),
        findUnique: vi.fn(async () => ({ ...credential, keys: [] })),
      },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })),
      },
      secret: { findUnique: findSecret },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore,
      deploymentModelKey: "fake-openrouter-deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", workspaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "gateway:fake",
      id: "fake/model",
      apiKey: "fake-custom-gateway-key",
      baseUrl: "http://127.0.0.1:11434/v1",
      allowPrivateNetwork: true,
      oauth: undefined,
    });

    findSecret.mockResolvedValueOnce(null);
    await expect(
      executor.resolveModel({ userId: "user-1", workspaceId: "workspace-1" }),
    ).resolves.toMatchObject({
      provider: "gateway:fake",
      apiKey: undefined,
    });
  });
});
