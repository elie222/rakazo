import type { CodexLiveCatalog } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createModelConnector } from "./model-credentials.js";
import type { RouterDeps } from "./router.js";

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
