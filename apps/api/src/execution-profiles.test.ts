import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { sendThreadMessage } from "./thread-target.js";

vi.mock("./thread-target.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendThreadMessage: vi.fn().mockResolvedValue({ taskId: "task", runId: "run", seq: 1 }),
}));
vi.mock("./taught-skills.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertTeachingSendAllowed: vi.fn().mockResolvedValue(undefined),
}));

const actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const input = {
  name: "Coding",
  harness: "claude" as const,
  provider: "anthropic",
  credentialId: "account-a",
  protocol: "anthropic" as const,
  endpoint: "https://api.example.test",
  modelId: "test-model",
  runtimeVersion: "0.3.300",
  computerId: null,
};
const profile = {
  ...input,
  id: "profile-a",
  seriesId: "series-a",
  revision: 1,
  spaceId: actor.spaceId,
  userId: actor.userId,
  createdAt: new Date(0),
};

function fixture() {
  const bot = {
    id: "bot",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name: "Bot",
    title: "",
    description: "",
    instructions: "",
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    parentBotId: null,
    memoryScope: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    thread: { id: "thread", unread: false, messages: [], runs: [] },
    computer: null,
    runs: [],
    executionProfileId: null as string | null,
    executionProfile: null as typeof profile | null,
  };
  const prisma = {
    spaceMember: { findFirst: vi.fn().mockResolvedValue({ id: "membership" }) },
    executionProfile: {
      findFirst: vi.fn().mockResolvedValue(profile),
      findMany: vi.fn().mockResolvedValue([profile]),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        ...data,
        id: "profile-new",
        createdAt: new Date(0),
      })),
    },
    userModelCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: "account-a",
        provider: "anthropic",
        userId: "owner",
        secretId: "secret-a",
        label: "Account A",
      }),
    },
    secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-a" }) },
    computer: { findFirst: vi.fn().mockResolvedValue(null) },
    bot: {
      findFirst: vi.fn().mockImplementation(async () => bot),
      findMany: vi.fn().mockImplementation(async () => [bot]),
      update: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(
          bot,
          Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
          { executionProfile: data.executionProfileId ? profile : null },
        );
        return bot;
      }),
    },
    spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const deps = {
    prisma,
    env: {
      agentRuntime: "pi",
      defaultProvider: "fake",
      defaultModel: "fake",
      sandboxProvider: "fake",
    },
    remoteConnectors: {
      resolveHostname: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    },
    events: { notify: vi.fn().mockResolvedValue(undefined) },
    secrets: { load: vi.fn().mockResolvedValue("fake-selected-key") },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { prisma, bot, deps, client };
}

describe("execution profile API", () => {
  it("rejects known text-only model image declarations without consulting another account", async () => {
    const { prisma, client } = fixture();
    await expect(
      client.executionProfiles.create({
        ...input,
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        endpoint: "https://openrouter.ai/api/v1",
        inputModalities: ["image"],
      }),
    ).rejects.toThrow("does not support image input");
    expect(prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-a", userId: "owner", provider: "openrouter" },
      }),
    );
    expect(prisma.executionProfile.create).not.toHaveBeenCalled();
  });

  it("persists explicit model-scoped image capability on a new revision", async () => {
    const { client, prisma } = fixture();
    const created = await client.executionProfiles.create({ ...input, inputModalities: ["image"] });
    expect(created.inputModalities).toEqual(["image"]);
    expect(prisma.executionProfile.create.mock.calls[0]![0].data.inputModalities).toEqual([
      "image",
    ]);
  });

  it("creates an immutable revision using authenticated scope and exact account", async () => {
    const { prisma, client } = fixture();
    const created = await client.executionProfiles.create(input);
    expect(created.id).toBe("profile-new");
    expect(prisma.userModelCredential.findFirst).toHaveBeenCalledWith({
      where: { id: "account-a", userId: "owner", provider: "anthropic" },
      include: { preferences: { where: { spaceId: "space", userId: "owner" } } },
    });
    const data = prisma.executionProfile.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ spaceId: "space", userId: "owner", revision: 1 });
    expect(data).not.toHaveProperty("email");
    expect(data).not.toHaveProperty("isDeploymentOwner");
    expect(created).not.toHaveProperty("userId");
    expect(created).not.toHaveProperty("secretId");
  });

  it("lists only the caller's space and user profiles", async () => {
    const { prisma, client } = fixture();
    await client.executionProfiles.list();
    expect(prisma.executionProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "space", userId: "owner" } }),
    );
  });

  it("rejects another user's account and a private endpoint", async () => {
    const { prisma, client } = fixture();
    prisma.userModelCredential.findFirst.mockResolvedValue(null);
    await expect(client.executionProfiles.create(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prisma.executionProfile.create).not.toHaveBeenCalled();
    await expect(
      client.executionProfiles.create({ ...input, endpoint: "http://127.0.0.1:1234" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("binds a revision in advanced bot settings and returns its effective DTO", async () => {
    const { prisma, client } = fixture();
    const updated = await client.bots.update({ botId: "bot", executionProfileId: "profile-a" });
    expect(updated.executionProfileId).toBe("profile-a");
    expect(updated.executionProfile?.harness).toBe("claude");
    expect(prisma.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ executionProfileId: "profile-a" }),
      }),
    );
  });

  it("refuses cross-space profile binding before writing the bot", async () => {
    const { prisma, client } = fixture();
    prisma.executionProfile.findFirst.mockResolvedValue(null);
    await expect(
      client.bots.update({ botId: "bot", executionProfileId: "foreign" }),
    ).rejects.toThrow();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("routes a bound native bot without requiring a Pi default account", async () => {
    const { bot, prisma, client } = fixture();
    bot.executionProfileId = "profile-a";
    bot.executionProfile = profile;
    await expect(client.threads.send({ botId: "bot", text: "hello" })).resolves.toMatchObject({
      runId: "run",
    });
    expect(sendThreadMessage).toHaveBeenCalled();
    expect(prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
  });

  it("rejects routine model overrides for profile-bound bots", async () => {
    const { bot, client } = fixture();
    bot.executionProfileId = "profile-a";
    await expect(
      client.routines.create({
        botId: "bot",
        name: "Review",
        prompt: "Review",
        crons: ["0 9 * * *"],
        timezone: "UTC",
        modelProvider: "anthropic",
        modelId: "other-model",
      }),
    ).rejects.toThrow("Clear the routine model override");
  });
});
