import type { AgentRunModel } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { computerCheckpointResolver, resolveComputerRunModel } from "./computer-model-settings.js";

const main: AgentRunModel = {
  provider: "openai",
  id: "gpt-4o",
  connectionId: "account-a",
  apiKey: "fake",
  acceptsImages: true,
};
const scope = { userId: "user", spaceId: "space" };
function setup(preference: unknown = null, space = false) {
  const prisma = {
    spaceSettingOverride: { findUnique: vi.fn(async () => (space ? {} : null)) },
    userModelPreference: { findFirst: vi.fn(async () => preference) },
    spaceModelPreference: { findFirst: vi.fn(async () => preference) },
  } as unknown as PrismaClient;
  const resolve = vi.fn(
    async (provider: string, id: string, connectionId: string, thinkingLevel?: string) =>
      ({ ...main, provider, id, connectionId, thinkingLevel }) as AgentRunModel,
  );
  return { prisma, resolve };
}
describe("computer model settings resolution", () => {
  it("keeps legacy unset and explicit same-main runs unchanged", async () => {
    const deps = setup();
    expect(await resolveComputerRunModel(deps, scope, main, null)).toBeUndefined();
    expect(await resolveComputerRunModel(deps, scope, main, { mode: "main" })).toBeUndefined();
    expect(deps.resolve).not.toHaveBeenCalled();
  });
  it("uses only the active connection's provider preference and medium effort", async () => {
    const deps = setup({ computerModelId: "gpt-4o-mini", computerThinkingLevel: null });
    expect(await resolveComputerRunModel(deps, scope, main, null)).toMatchObject({
      id: "gpt-4o-mini",
      connectionId: "account-a",
      thinkingLevel: "medium",
    });
    expect(deps.prisma.userModelPreference.findFirst).toHaveBeenCalledWith({
      where: { userId: "user", credentialId: "account-a" },
    });
  });
  it.each([false, true])(
    "resolves an explicit cross-provider connection default (Space=%s)",
    async (space) => {
      const deps = setup(
        {
          computerProvider: "anthropic",
          computerCredentialId: "claude",
          computerModelId: "claude-sonnet-4-5",
        },
        space,
      );
      expect(await resolveComputerRunModel(deps, scope, main, null)).toMatchObject({
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        connectionId: "claude",
        thinkingLevel: "medium",
      });
      expect(deps.resolve).toHaveBeenCalledWith(
        "anthropic",
        "claude-sonnet-4-5",
        "claude",
        "medium",
      );
    },
  );
  it("uses Space policy instead of account policy", async () => {
    const deps = setup({ computerModelId: "gpt-4o-mini", computerThinkingLevel: "low" }, true);
    expect(await resolveComputerRunModel(deps, scope, main, null)).toMatchObject({
      thinkingLevel: "low",
    });
    expect(deps.prisma.spaceModelPreference.findFirst).toHaveBeenCalledWith({
      where: { ...scope, credentialId: "account-a" },
    });
    expect(deps.prisma.userModelPreference.findFirst).not.toHaveBeenCalled();
  });
  it("filters Space policy by member only when given a whole run row", async () => {
    const deps = setup({ computerModelId: "gpt-4o-mini" }, true);
    const run = { ...scope, id: "run", botId: "bot", status: "running", leaseFence: 1 };
    await resolveComputerRunModel(deps, run, main, null);
    expect(deps.prisma.spaceModelPreference.findFirst).toHaveBeenCalledWith({
      where: { ...scope, credentialId: "account-a" },
    });
  });
  it("explicit same-main suppresses a provider default; null inherits it", async () => {
    const deps = setup({ computerModelId: "gpt-4o-mini" });
    expect(await resolveComputerRunModel(deps, scope, main, { mode: "main" })).toBeUndefined();
    expect(deps.prisma.userModelPreference.findFirst).not.toHaveBeenCalled();
    expect(await resolveComputerRunModel(deps, scope, main, null)).toMatchObject({
      id: "gpt-4o-mini",
    });
  });
  it("allows explicit cross-provider/auth choices but rejects substituted accounts", async () => {
    const deps = setup();
    const selection = {
      mode: "model",
      provider: "openai",
      modelId: "gpt-4o-mini",
      credentialId: "account-b",
    };
    await expect(
      resolveComputerRunModel(deps, scope, main, {
        ...selection,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).resolves.toMatchObject({ provider: "anthropic", connectionId: "account-b" });
    deps.resolve.mockResolvedValueOnce({ ...main, connectionId: "other" });
    await expect(resolveComputerRunModel(deps, scope, main, selection)).rejects.toThrow(
      /connection/,
    );
    deps.resolve.mockResolvedValueOnce({
      ...main,
      id: selection.modelId,
      connectionId: "account-b",
      oauth: {
        credential: {
          type: "oauth",
          access: "target-token",
          refresh: "target-refresh",
          expires: 9999999999999,
        },
      },
    });
    await expect(resolveComputerRunModel(deps, scope, main, selection)).resolves.toMatchObject({
      connectionId: "account-b",
      oauth: { credential: { access: "target-token" } },
    });
  });
  it("rejects nonvision and missing targets, never tries a backup", async () => {
    const deps = setup({ computerModelId: "gpt-4o-mini" });
    deps.resolve.mockResolvedValueOnce({ ...main, id: "gpt-4o-mini", acceptsImages: false });
    await expect(resolveComputerRunModel(deps, scope, main, null)).rejects.toThrow(/image/);
    deps.resolve.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(resolveComputerRunModel(deps, scope, main, null)).rejects.toThrow("Disconnected");
    expect(deps.resolve).toHaveBeenCalledTimes(2);
  });
  it("does not configure an unrelated provider after main failover", async () => {
    const deps = setup();
    expect(
      await resolveComputerRunModel(
        deps,
        scope,
        { ...main, provider: "anthropic", connectionId: "claude" },
        null,
      ),
    ).toBeUndefined();
    expect(deps.resolve).not.toHaveBeenCalled();
  });
});
it("leaves legacy checkpoint compatibility to the existing executor, including provider changes", () => {
  expect(
    computerCheckpointResolver(
      JSON.stringify({ version: 1, provider: "anthropic", model: "old", messages: [] }),
      main,
      vi.fn(),
    ),
  ).toBeUndefined();
});
it("checkpoint resolution permits only saved identities, even after settings were cleared", async () => {
  const resolve = vi.fn(async (provider: string, id: string, connectionId: string) => ({
    ...main,
    provider,
    id,
    connectionId,
  }));
  const checkpoint = JSON.stringify({
    version: 1,
    provider: main.provider,
    model: main.id,
    systemPrompt: "",
    pendingToolCallId: "call",
    messages: [],
    computerMode: {
      version: 1,
      mode: "computer",
      main: { provider: main.provider, id: main.id, connectionId: "account-a", auth: "api-key" },
      computer: {
        provider: "openai",
        id: "gpt-4o-mini",
        connectionId: "account-b",
        auth: "api-key",
      },
    },
  });
  const resolver = computerCheckpointResolver(checkpoint, main, resolve);
  expect(await resolver?.("openai", "gpt-4o-mini", "account-b")).toMatchObject({
    connectionId: "account-b",
  });
  await expect(resolver?.("openai", "gpt-4o-mini", "other")).rejects.toThrow(/pinned/);
});
