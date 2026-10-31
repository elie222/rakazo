import type { Actor, ComputerModelSelection, ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { computerModelSettings } from "./computer-model-settings.js";

const actor = { userId: "user", spaceId: "space" } as Actor;
const target = { kind: "connection", credentialId: "conn", scope: "account" } as const;
const selection = {
  mode: "model",
  provider: "openai-compatible",
  credentialId: "conn",
  modelId: "vision",
  thinkingLevel: null,
} as const;
function fixture() {
  const credential = {
    id: "conn",
    userId: "user",
    provider: "openai-compatible",
    secretId: "secret",
    defaultModel: "vision",
    label: "Local",
    userPreferences: [],
  };
  let account: Record<string, unknown> | null = null;
  let space: Record<string, unknown> | null = null;
  const bot = {
    id: "bot",
    userId: "user",
    spaceId: "space",
    modelProvider: null,
    modelId: null,
    computerModel: null as ComputerModelSelection,
  };
  let secret: Record<string, unknown> = {
    kind: "openai_compatible",
    provider: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "fake",
    enabledModelIds: ["vision", "text"],
    visionModelIds: ["vision"],
  };
  const userPreference = {
    findFirst: vi.fn(async () => account),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        account = account ? { ...account, ...update } : create;
        return account;
      },
    ),
  };
  const credentials = [credential];
  const prisma = {
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        credentials.filter((c) => c.userId === where.userId),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          credentials.find((c) => c.id === where.id && c.userId === where.userId) ?? null,
      ),
    },
    userModelPreference: userPreference,
    spaceModelPreference: {
      findFirst: vi.fn(async () => space),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          space = space ? { ...space, ...update } : create;
          return space;
        },
      ),
    },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async () => [
        {
          provider: "openai-compatible",
          modelId: "vision",
          credentialId: "conn",
          thinkingLevel: "high",
          position: 0,
        },
      ]),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) =>
        where.id === bot.id && where.userId === bot.userId && where.spaceId === bot.spaceId
          ? bot
          : null,
      ),
      updateMany: vi.fn(async ({ data }: { data: { computerModel: ComputerModelSelection } }) => {
        bot.computerModel =
          data.computerModel && "mode" in data.computerModel ? data.computerModel : null;
        return { count: 1 };
      }),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  const secrets = { load: vi.fn(async (_ciphertext?: string) => JSON.stringify(secret)) };
  const catalog = vi.fn(
    async () =>
      [
        {
          provider: "openai-compatible",
          id: "vision",
          label: "Vision",
          billing: "local",
          images: true,
          thinkingLevels: ["low", "medium", "high"],
        },
        {
          provider: "openai-compatible",
          id: "text",
          label: "Text",
          billing: "local",
          images: false,
        },
        {
          provider: "openai-compatible",
          id: "other-account",
          label: "Other",
          billing: "local",
          credentialIds: ["other"],
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          label: "Claude",
          billing: "paid",
          images: true,
        },
      ] as ModelCatalogEntry[],
  );
  const api = computerModelSettings(
    { prisma, secrets } as unknown as Parameters<typeof computerModelSettings>[0],
    catalog,
  );
  return {
    api,
    credentials,
    catalog,
    secrets,
    prisma,
    bot,
    secret: (value: Record<string, unknown>) => {
      secret = value;
    },
    account: () => account,
    seedAccount: (value: Record<string, unknown>) => {
      account = value;
    },
  };
}
describe("computer settings persistence and authorization", () => {
  it("loads only image models served by the exact connection, with no automatic choice", async () => {
    const { api } = fixture();
    expect(await api.load(actor, target)).toMatchObject({
      selection: null,
      options: [{ modelId: "vision", credentialId: "conn" }],
    });
    expect((await api.load(actor, target)).options).toHaveLength(1);
  });
  it.each(["account", "space", "bot"] as const)(
    "selects another owned provider and reads back/clears %s",
    async (scope) => {
      const f = fixture();
      f.credentials.push({
        ...f.credentials[0]!,
        id: "claude",
        provider: "anthropic",
        secretId: "claude-secret",
        label: "Claude account",
      });
      f.secrets.load.mockImplementation(async () =>
        JSON.stringify({ kind: "api_key", key: "fake-target" }),
      );
      const choice = {
        ...selection,
        provider: "anthropic",
        credentialId: "claude",
        modelId: "claude-sonnet-4-5",
      };
      const dest = scope === "bot" ? { kind: "bot" as const, botId: "bot" } : { ...target, scope };
      expect((await f.api.load(actor, dest)).options).toContainEqual(
        expect.objectContaining({
          provider: "anthropic",
          credentialId: "claude",
          modelId: "claude-sonnet-4-5",
        }),
      );
      expect((await f.api.save(actor, dest, choice)).selection).toEqual(choice);
      expect((await f.api.load(actor, dest)).selection).toEqual(choice);
      expect((await f.api.save(actor, dest, null)).selection).toBeNull();
      if (scope === "account")
        expect(f.account()).toMatchObject({
          computerCredentialId: null,
          computerProvider: null,
          hasMainPreference: false,
        });
    },
  );
  it("excludes another owner's cross-provider credential even when its catalog model is visible", async () => {
    const f = fixture();
    f.credentials.push({
      ...f.credentials[0]!,
      id: "foreign",
      userId: "other",
      provider: "anthropic",
    });
    expect(
      (await f.api.load(actor, target)).options.every((o) => o.credentialId !== "foreign"),
    ).toBe(true);
    await expect(
      f.api.save(actor, target, {
        ...selection,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        credentialId: "foreign",
      }),
    ).rejects.toThrow(/available vision/);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("keeps a disconnected cross-provider pin visible and clearable without borrowing source credentials", async () => {
    const f = fixture();
    f.seedAccount({
      computerProvider: "anthropic",
      computerCredentialId: "deleted",
      computerModelId: "claude-sonnet-4-5",
      computerThinkingLevel: null,
    });
    const view = await f.api.load(actor, target);
    expect(view.selection).toMatchObject({
      provider: "anthropic",
      credentialId: "deleted",
      modelId: "claude-sonnet-4-5",
    });
    expect(view.options.every((o) => o.credentialId !== "deleted")).toBe(true);
    await expect(f.api.save(actor, target, view.selection)).rejects.toThrow(/available vision/);
    expect((await f.api.save(actor, target, null)).selection).toBeNull();
  });
  it("offers an explicit OAuth target alongside an API-key source without requiring equal auth families", async () => {
    const f = fixture();
    f.credentials.push({
      ...f.credentials[0]!,
      id: "claude",
      provider: "anthropic",
      label: "Subscription",
      secretId: "oauth-secret",
    });
    f.prisma.secret.findFirst.mockImplementation(async ({ where }) => ({
      id: where.id,
      ciphertext: where.id,
    }));
    f.secrets.load.mockImplementation(async (ciphertext) =>
      JSON.stringify(
        ciphertext === "oauth-secret"
          ? {
              kind: "oauth",
              credential: {
                type: "oauth",
                access: "fixture-token",
                refresh: "fixture-refresh",
                expires: 9999999999999,
              },
            }
          : { kind: "api_key", key: "source-key" },
      ),
    );
    const choice = {
      ...selection,
      provider: "anthropic",
      credentialId: "claude",
      modelId: "claude-sonnet-4-5",
    };
    expect((await f.api.load(actor, target)).options).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        credentialId: "claude",
        modelId: choice.modelId,
        label: expect.stringContaining("OAuth"),
      }),
    );
    expect((await f.api.save(actor, target, choice)).selection).toEqual(choice);
  });
  it("saves, reads back, and clears without changing main pins, effort or priority", async () => {
    const f = fixture();
    const updatedAt = new Date("2026-01-01");
    f.seedAccount({ modelId: "text", thinkingLevel: "high", updatedAt });
    expect((await f.api.save(actor, target, selection)).selection).toEqual(selection);
    expect(f.account()).toMatchObject({
      modelId: "text",
      thinkingLevel: "high",
      updatedAt,
      computerModelId: "vision",
    });
    expect((await f.api.save(actor, target, null)).selection).toBeNull();
    expect(f.prisma.userModelPreference.findFirst.mock.calls.length).toBeGreaterThan(2);
  });
  it("retries a save that loses a serialization conflict", async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("serialization conflict"), { code: "P2034" }),
    );
    expect((await f.api.save(actor, target, selection)).selection).toEqual(selection);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
  it("keeps Space defaults separate from account defaults", async () => {
    const f = fixture();
    await f.api.save(actor, { ...target, scope: "space" }, selection);
    expect((await f.api.load(actor, target)).selection).toBeNull();
    expect((await f.api.load(actor, { ...target, scope: "space" })).selection).toEqual(selection);
    expect(f.prisma.userModelPreference.upsert).not.toHaveBeenCalled();
  });
  it.each([
    { ...selection, credentialId: "someone-else" },
    { ...selection, provider: "anthropic" },
    { ...selection, modelId: "text" },
    { ...selection, modelId: "missing" },
    { ...selection, thinkingLevel: "xhigh" },
  ] as ComputerModelSelection[])(
    "rejects unavailable, nonvision, wrong account/provider/effort: %j",
    async (choice) => {
      const f = fixture();
      await expect(f.api.save(actor, target, choice)).rejects.toThrow(/available vision/);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects another user's connection and bot, including clears", async () => {
    const f = fixture();
    await expect(f.api.load({ ...actor, userId: "other" }, target)).rejects.toThrow();
    await expect(
      f.api.save({ ...actor, userId: "other" }, { kind: "bot", botId: "bot" }, null),
    ).rejects.toThrow();
    await expect(
      f.api.load({ ...actor, spaceId: "other" }, { kind: "bot", botId: "bot" }),
    ).rejects.toThrow();
  });
  it("offers and persists a bot override on an owned connection", async () => {
    const f = fixture();
    const botTarget = { kind: "bot", botId: "bot" } as const;
    expect(
      (await f.api.load(actor, botTarget)).options.map((option) => option.credentialId),
    ).toEqual(["conn"]);
    expect((await f.api.save(actor, botTarget, selection)).selection).toEqual(selection);
    expect(f.bot.modelId).toBeNull();
  });
  it("distinguishes bot same-main from inherited provider default", async () => {
    const f = fixture();
    const botTarget = { kind: "bot", botId: "bot" } as const;
    expect((await f.api.save(actor, botTarget, { mode: "main" })).selection).toEqual({
      mode: "main",
    });
    expect((await f.api.save(actor, botTarget, null)).selection).toBeNull();
    expect(f.prisma.bot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { computerModel: { mode: "main" } } }),
    );
  });
  it("keeps unreadable connections unselectable but allows clearing their saved default", async () => {
    const f = fixture();
    f.seedAccount({ computerModelId: "vision", computerThinkingLevel: null });
    f.prisma.secret.findFirst.mockResolvedValue(null as never);
    expect(await f.api.load(actor, target)).toMatchObject({ selection, options: [] });
    await expect(f.api.save(actor, target, selection)).rejects.toThrow(/available vision/);
    expect((await f.api.save(actor, target, null)).selection).toBeNull();
  });
});
