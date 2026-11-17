import type * as Adapters from "@rakazo/adapters";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ModelConnectInputSchema, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createModelConnector } from "./model-credentials.js";

const compatibleKeyCheck = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/adapters", async (importOriginal) => {
  const adapters = await importOriginal<typeof Adapters>();
  compatibleKeyCheck.mockImplementation(adapters.verifyOpenAiCompatibleApiKey);
  return { ...adapters, verifyOpenAiCompatibleApiKey: compatibleKeyCheck };
});

describe("project routing connection checks", () => {
  it.each([
    {
      name: "unchanged routing",
      routing: { projectId: "example-project", region: "global" },
      input: { projectId: "example-project", region: "global", maxTokens: 4096 },
      checked: false,
    },
    {
      name: "changed region",
      routing: { projectId: "example-project", region: "global" },
      input: { region: "us-central1" },
      checked: true,
    },
    {
      name: "added project",
      routing: {},
      input: { projectId: "example-project", region: "global" },
      checked: true,
    },
    { name: "new key", routing: {}, input: { apiKey: "replacement-fixture-key" }, checked: true },
    {
      name: "corrupt saved material",
      routing: {},
      input: { apiKey: "replacement-fixture-key" },
      checked: true,
      stored: '{"kind":"api_key","key":17}',
    },
    {
      name: "empty saved key",
      routing: {},
      input: { apiKey: "replacement-fixture-key" },
      checked: true,
      stored: '{"kind":"api_key","key":""}',
    },
    { name: "legacy limits", routing: {}, input: { maxTokens: 4096 }, checked: false },
  ])("checks only connection changes: $name", async (scenario) => {
    const { routing, input, checked } = scenario;
    const check = vi.fn(async () => undefined);
    const saved = {
      id: "credential-fixture",
      userId: "user-fixture",
      provider: "google-vertex",
      secretId: "secret-fixture",
    };
    const deps = {
      env: {},
      prisma: {
        userModelCredential: { findFirst: vi.fn(async () => saved) },
        secret: { findFirst: vi.fn(async () => ({ ciphertext: "fixture-ciphertext" })) },
      },
      secrets: {
        load: vi.fn(async () =>
          "stored" in scenario
            ? scenario.stored
            : JSON.stringify({ kind: "api_key", key: "fixture-model-key", ...routing }),
        ),
      },
      modelConnectionCheck: check,
    } as unknown as RouterDeps;
    const connector = createModelConnector(deps, {} as CodexLiveCatalog);
    await connector.verifyModelConnection(
      { userId: "user-fixture", spaceId: "space-fixture" } as Actor,
      ModelConnectInputSchema.parse({
        provider: saved.provider,
        credentialId: saved.id,
        modelId: "gemini-4-hydrogen",
        ...input,
      }),
      undefined,
    );
    expect(check).toHaveBeenCalledTimes(checked ? 1 : 0);
    if (checked)
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: saved.provider,
          id: "gemini-4-hydrogen",
          ...routing,
          ...input,
        }),
        expect.any(Object),
      );
  });
});

describe("failed connection messages", () => {
  function connector(check: () => Promise<void>) {
    const saved = {
      id: "credential-fixture",
      userId: "user-fixture",
      provider: "google-vertex",
      secretId: "secret-fixture",
    };
    const deps = {
      env: {},
      prisma: {
        userModelCredential: { findFirst: vi.fn(async () => saved) },
        secret: { findFirst: vi.fn(async () => ({ ciphertext: "fixture-ciphertext" })) },
      },
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "api_key",
            key: "fixture-saved-key",
            projectId: "example-project",
            region: "global",
          }),
        ),
      },
      modelConnectionCheck: check,
    } as unknown as RouterDeps;
    const { verifyModelConnection } = createModelConnector(deps, {} as CodexLiveCatalog);
    return (input: Record<string, unknown>) =>
      verifyModelConnection(
        { userId: "user-fixture", spaceId: "space-fixture" } as Actor,
        ModelConnectInputSchema.parse({
          provider: saved.provider,
          credentialId: saved.id,
          modelId: "gemini-4-hydrogen",
          ...input,
        }),
        undefined,
      );
  }

  it("hides the key the request carries", async () => {
    const verify = connector(async () => {
      throw new Error("The provider did not accept replacement-fixture-key for this project.");
    });
    await expect(verify({ apiKey: "replacement-fixture-key" })).rejects.toThrow(
      "The provider did not accept ••• for this project.",
    );
  });

  it("hides a saved key the request reuses, which the client never held", async () => {
    const verify = connector(async () => {
      throw new Error("The provider did not accept fixture-saved-key for this project.");
    });
    await expect(verify({ region: "us-central1" })).rejects.toThrow(
      "The provider did not accept ••• for this project.",
    );
  });

  it("hides a saved server's key and headers when a reconnect reuses them", async () => {
    const baseUrl = "https://models.example.com/v1";
    const saved = {
      id: "credential-fixture",
      userId: "user-fixture",
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      secretId: "secret-fixture",
    };
    const deps = {
      env: {},
      prisma: {
        userModelCredential: { findFirst: vi.fn(async () => saved) },
        secret: { findFirst: vi.fn(async () => ({ ciphertext: "fixture-ciphertext" })) },
      },
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl,
            apiKey: "fixture-saved-key",
            headers: { "x-session": "fixture-saved-header" },
          }),
        ),
      },
    } as unknown as RouterDeps;
    compatibleKeyCheck.mockRejectedValueOnce(
      new Error("The server refused fixture-saved-key sent with fixture-saved-header."),
    );
    const { verifyModelConnection } = createModelConnector(deps, {} as CodexLiveCatalog);
    await expect(
      verifyModelConnection(
        { userId: "user-fixture", spaceId: "space-fixture" } as Actor,
        ModelConnectInputSchema.parse({
          provider: saved.provider,
          credentialId: saved.id,
          modelId: "example-model",
          baseUrl,
        }),
        undefined,
      ),
    ).rejects.toThrow("The server refused ••• sent with •••.");
    expect(compatibleKeyCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "fixture-saved-key",
        headers: { "x-session": "fixture-saved-header" },
      }),
      undefined,
      undefined,
    );
  });

  it("hides a credential it was not given, by its shape", async () => {
    const verify = connector(async () => {
      throw new Error("Incorrect API key provided: other-fixture-1234. Check the key.");
    });
    await expect(verify({ apiKey: "replacement-fixture-key" })).rejects.toThrow(
      "Incorrect API key provided: •••. Check the key.",
    );
  });
});
