import type { AgentRuntimeEvent, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  profileHistoryMessage,
  requireRuntimeCompletion,
  resolveProfileModel,
  validatePiProfileModel,
} from "./execution-profile-runtime.js";

function deps(plaintext: string, available = true) {
  return {
    prisma: {
      secret: {
        findFirst: vi.fn(async () =>
          available ? { id: "secret-A", ciphertext: "encrypted" } : null,
        ),
      },
    } as unknown as PrismaClient,
    secretStore: { load: vi.fn(async () => plaintext) } as unknown as SecretStore,
  };
}
const scope = { userId: "user-A" };
const profile = {
  provider: "compatible",
  modelId: "model",
  endpoint: "https://models.example.test/anthropic",
};
const credential = { id: "account-A", userId: "user-A", secretId: "secret-A" };

describe("explicit execution profile credentials", () => {
  it("resolves the exact credential without model catalog or default-account fallback", async () => {
    const dependencies = deps("fake-key-A");
    const result = await resolveProfileModel(dependencies, scope, profile, credential);
    expect(result.model).toMatchObject({
      provider: "compatible",
      id: "model",
      apiKey: "fake-key-A",
      baseUrl: profile.endpoint,
    });
    expect(dependencies.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-A", userId: "user-A", spaceId: null },
    });
    expect(result.redact).toContain("fake-key-A");
  });
  it("keeps two accounts for the same provider and model distinct", async () => {
    const a = await resolveProfileModel(deps("fake-key-A"), scope, profile, credential);
    const b = await resolveProfileModel(deps("fake-key-B"), scope, profile, {
      ...credential,
      id: "account-B",
      secretId: "secret-B",
    });
    expect(a.model.apiKey).not.toBe(b.model.apiKey);
    expect(a.model.provider).toBe(b.model.provider);
    expect(a.model.id).toBe(b.model.id);
  });
  it("fails closed for revoked or cross-user accounts", async () => {
    await expect(
      resolveProfileModel(deps("fake-key", false), scope, profile, credential),
    ).rejects.toThrow("no longer available");
    const dependencies = deps("fake-key");
    await expect(
      resolveProfileModel(dependencies, scope, profile, { ...credential, userId: "other" }),
    ).rejects.toThrow("not authorized");
    expect(dependencies.secretStore.load).not.toHaveBeenCalled();
  });
  it("rejects subscription credentials without refreshing or repurposing them", async () => {
    const stored = JSON.stringify({
      kind: "oauth",
      credential: { type: "oauth", access: "fake", refresh: "fake", expires: 123 },
    });
    await expect(resolveProfileModel(deps(stored), scope, profile, credential)).rejects.toThrow(
      "API-key",
    );
  });
});

describe("primary harness terminal contract", () => {
  async function* stream(events: AgentRuntimeEvent[]) {
    yield* events;
  }
  async function collect(events: AgentRuntimeEvent[]) {
    const values = [];
    for await (const event of requireRuntimeCompletion(stream(events))) values.push(event);
    return values;
  }
  it("requires a business terminal event, not process EOF", async () => {
    await expect(collect([{ type: "text", text: "partial" }])).rejects.toThrow("interrupted");
    await expect(collect([])).rejects.toThrow("interrupted");
    await expect(collect([{ type: "done" }])).resolves.toEqual([{ type: "done" }]);
  });
  it("rejects output and duplicate terminal events after completion", async () => {
    await expect(collect([{ type: "done" }, { type: "text", text: "late" }])).rejects.toThrow(
      "after its terminal",
    );
  });
});

describe("mixed-harness group identity", () => {
  it("preserves other speakers instead of attributing their history to the target bot", () => {
    expect(profileHistoryMessage({ role: "bot", botId: "sender" }, "target", "work")).toEqual({
      role: "user",
      content: "[Message from bot sender]\nwork",
    });
    expect(profileHistoryMessage({ role: "bot", botId: "target" }, "target", "own work")).toEqual({
      role: "assistant",
      content: "own work",
    });
    expect(profileHistoryMessage({ role: "system" }, "target", "system")).toEqual({
      role: "system",
      content: "system",
    });
  });
});

describe("Pi profile driver validation", () => {
  it("rejects a missing exact provider instead of Pi's historical model-name fallback", () => {
    expect(() =>
      validatePiProfileModel(
        { provider: "missing-provider", id: "missing-model", apiKey: "fake" },
        "anthropic",
        null,
      ),
    ).toThrow("exact provider");
  });
  it("requires the configured protocol to match the actual compatible driver", () => {
    const model = {
      provider: "openai-compatible",
      id: "custom-model",
      apiKey: "fake",
      baseUrl: "https://models.example.test/v1",
    };
    expect(() =>
      validatePiProfileModel(model, "openai-chat-completions", model.baseUrl),
    ).not.toThrow();
    expect(() => validatePiProfileModel(model, "anthropic", model.baseUrl)).toThrow("protocol");
  });
  it("does not silently ignore an endpoint override for a catalog-only Pi provider", () => {
    expect(() =>
      validatePiProfileModel(
        { provider: "anthropic", id: "model", apiKey: "fake" },
        "anthropic",
        "https://models.example.test",
      ),
    ).toThrow("endpoint overrides");
  });
});

const nativeDescriptor = {
  kind: "native_login",
  installationId: "a".repeat(32),
  harness: "codex",
  connectionId: "11111111-1111-4111-8111-111111111111",
  epoch: "22222222-2222-4222-8222-222222222222",
  spaceId: "space-A",
  computerId: "computer-A",
  computerProviderRef: "container-A",
  computerHomeKey: "home-A",
  state: "ready",
  region: "global",
};
const nativeProfile = {
  ...profile,
  provider: "native-codex",
  harness: "codex",
  computerId: "computer-A",
  endpoint: "https://chatgpt.com/backend-api/codex",
  authScheme: "api-key",
  modelRoles: {},
  inputModalities: [],
};
describe("native subscription account binding", () => {
  it("never converts a damaged native account record into an API-key request", async () => {
    await expect(
      resolveProfileModel(
        deps("{damaged descriptor"),
        { ...scope, spaceId: "space-A" },
        nativeProfile,
        credential,
      ),
    ).rejects.toThrow("Native login account configuration is invalid");
  });

  it("passes only the descriptor and never extracts an API token", async () => {
    const result = await resolveProfileModel(
      deps(JSON.stringify(nativeDescriptor)),
      { ...scope, spaceId: "space-A" },
      nativeProfile,
      credential,
    );
    expect(result.model.nativeLogin).toEqual(nativeDescriptor);
    expect(result.model.apiKey).toBeUndefined();
    expect(result.redact).toEqual([]);
  });
  it.each([
    { state: "pending" },
    { state: "disconnected" },
    { spaceId: "other-space" },
    { computerId: "other-computer" },
    { harness: "kimi" },
  ])("rejects an incompatible or revoked descriptor %j", async (change) => {
    await expect(
      resolveProfileModel(
        deps(JSON.stringify({ ...nativeDescriptor, ...change })),
        { ...scope, spaceId: "space-A" },
        nativeProfile,
        credential,
      ),
    ).rejects.toThrow("Native login requires");
  });
  it.each([
    { provider: "openai" },
    { harness: "pi" },
    { endpoint: "https://custom.example.test" },
    { computerId: null },
    { authScheme: "bearer" },
    { modelRoles: { haiku: "model" } },
    { inputModalities: ["audio"] },
  ])("rejects incompatible profile settings %j", async (change) => {
    await expect(
      resolveProfileModel(
        deps(JSON.stringify(nativeDescriptor)),
        { ...scope, spaceId: "space-A" },
        { ...nativeProfile, ...change },
        credential,
      ),
    ).rejects.toThrow("Native login requires");
  });
});
