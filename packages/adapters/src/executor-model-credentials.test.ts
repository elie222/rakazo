import { describe, expect, it, vi } from "vitest";
import { type ExecutorDeps, resolveModelKey } from "./executor.js";

function credentialDeps(secret: { id: string; ciphertext: string } | null) {
  return {
    prisma: {
      userModelCredential: {
        findUnique: vi.fn(async () => ({
          secretId: "fallback-secret",
          keys: [
            {
              secretId: "matching-secret",
              isActive: false,
              availableModels: "gemini-test-model",
            },
            {
              secretId: "fallback-secret",
              isActive: true,
              availableModels: "gpt-test-model",
            },
          ],
        })),
      },
      secret: {
        findUnique: vi.fn(async () => secret),
        update: vi.fn(async () => undefined),
      },
    },
    secretStore: {
      load: vi.fn((ciphertext: string) => ciphertext),
      put: vi.fn(async () => ({ id: "replacement", ciphertext: "replacement" })),
    },
    deploymentModelKey: "fake-deployment-key",
  } as unknown as ExecutorDeps;
}

describe("gateway model credential resolution", () => {
  it("selects the key whose coverage contains the requested model", async () => {
    const deps = credentialDeps({ id: "matching-secret", ciphertext: "fake-matching-key" });

    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "workspace-1",
      { id: "credential-1", secretId: "fallback-secret", provider: "gateway:test" },
      "gateway:test",
      "gemini-test-model",
    );

    expect(deps.prisma.secret.findUnique).toHaveBeenCalledWith({
      where: { id: "matching-secret" },
    });
    expect(resolved.apiKey).toBe("fake-matching-key");
    expect(resolved.redact).toContain("fake-matching-key");
  });

  it("never sends the deployment key to a custom endpoint when its personal key is missing", async () => {
    const deps = credentialDeps(null);

    const resolved = await resolveModelKey(
      deps,
      "user-1",
      "workspace-1",
      { id: "credential-1", secretId: "fallback-secret", provider: "gateway:test" },
      "gateway:test",
      "gemini-test-model",
    );

    expect(resolved).toEqual({ redact: [] });
    expect(JSON.stringify(resolved)).not.toContain("fake-deployment-key");
  });

  it("still uses the deployment key when no personal credential exists", async () => {
    const deps = credentialDeps(null);

    await expect(
      resolveModelKey(deps, "user-1", "workspace-1", null, "openrouter", "gpt-test-model"),
    ).resolves.toEqual({ apiKey: "fake-deployment-key", redact: [] });
  });
});
