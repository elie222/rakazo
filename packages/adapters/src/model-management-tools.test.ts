import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  listModelConnectionsFromTool,
  testModelConnectionFromTool,
} from "./model-management-tools.js";
import { serializeModelSecret } from "./model-secret.js";

const run = { id: "run-1", spaceId: "space-1", userId: "user-1" };

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const plaintext = serializeModelSecret({
    kind: "openai_compatible",
    baseUrl: "https://relay.example.test",
    apiProtocol: "anthropic-messages",
    authMode: "x-api-key",
    apiKey: "test-key-that-must-never-leak",
    enabledModelIds: ["model-a", "model-b"],
  });
  const prisma = {
    userModelCredential: {
      findMany: vi.fn(async () => [
        {
          id: "cred-1",
          userId: "user-1",
          provider: "openai-compatible",
          label: "Test Relay",
          secretId: "secret-1",
          supportsImages: true,
          userPreferences: [{ modelId: "model-a" }],
        },
      ]),
    },
    secret: {
      findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "ciphertext-1" })),
    },
  };
  const secretStore = {
    load: vi.fn(async () => plaintext),
  };
  return {
    deps: {
      prisma,
      secretStore,
      ...overrides,
    } as unknown as ExecutorDeps,
    plaintext,
  };
}

describe("listModelConnectionsFromTool", () => {
  it("lists connections with labels and models, never the API key", async () => {
    const { deps, plaintext } = fakeDeps();
    const result = await listModelConnectionsFromTool(deps, run);
    const text = JSON.stringify(result);
    expect(text).not.toContain("test-key-that-must-never-leak");
    expect(text).not.toContain(plaintext);
    expect(result.connections).toMatchObject([
      {
        id: "cred-1",
        provider: "openai-compatible",
        label: "Test Relay",
        baseUrl: "https://relay.example.test",
        defaultModel: "model-a",
        models: ["model-a", "model-b"],
        authMode: "x-api-key",
        hasKey: true,
      },
    ]);
  });

  it("reports when there are no connections", async () => {
    const { deps } = fakeDeps();
    (
      deps.prisma as unknown as {
        userModelCredential: { findMany: ReturnType<typeof vi.fn> };
      }
    ).userModelCredential.findMany = vi.fn(async () => []);
    const result = await listModelConnectionsFromTool(deps, run);
    expect(result.connections).toEqual([]);
  });
});

describe("testModelConnectionFromTool", () => {
  it("asks for a connection when none is given", async () => {
    const { deps } = fakeDeps();
    const result = await testModelConnectionFromTool(deps, run, {});
    expect(result.error).toMatch(/which connection/i);
  });

  it("reports when no connection matches", async () => {
    const { deps } = fakeDeps();
    const result = await testModelConnectionFromTool(deps, run, {
      connection: "no-such-provider",
    });
    expect(result.error).toMatch(/no model connection matches/i);
  });

  it("reports when the saved key cannot be read", async () => {
    const { deps } = fakeDeps();
    (deps.secretStore as unknown as { load: ReturnType<typeof vi.fn> }).load = vi.fn(async () => {
      throw new Error("decrypt failed");
    });
    const result = await testModelConnectionFromTool(deps, run, {
      connection: "Test Relay",
    });
    expect(result.error).toMatch(/could not read the saved key/i);
  });
});
