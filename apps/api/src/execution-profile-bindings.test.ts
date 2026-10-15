import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { EXECUTION_HARNESS_VERSIONS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
function fixture(
  profileComputerId: string | null,
  botComputerId: string | null = "current-computer",
) {
  const profile = {
    id: "profile",
    seriesId: "series",
    revision: 1,
    name: "Coding",
    spaceId: "space",
    userId: "user",
    harness: "claude",
    provider: "anthropic",
    credentialId: "account",
    protocol: "anthropic",
    authScheme: "api-key",
    modelRoles: {},
    endpoint: "https://api.anthropic.com",
    modelId: "model",
    runtimeVersion: EXECUTION_HARNESS_VERSIONS.claude,
    inputModalities: [],
    computerId: profileComputerId,
    createdAt: new Date(0),
  };
  const bot = {
    id: "bot",
    spaceId: "space",
    userId: "user",
    name: "Builder",
    title: "",
    description: "",
    instructions: "",
    color: "robot:default",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    parentBotId: null,
    memoryScope: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    computerId: botComputerId,
    computer: { scope: "dedicated" },
    thread: { id: "thread", unread: false, messages: [], runs: [] },
    runs: [],
    executionProfileId: null as string | null,
    executionProfile: null as typeof profile | null,
  };
  const update = vi.fn(async ({ data }: { data: { executionProfileId?: string | null } }) => {
    bot.executionProfileId = data.executionProfileId ?? null;
    bot.executionProfile = data.executionProfileId ? profile : null;
    return bot;
  });
  const prisma = {
    bot: { findFirst: vi.fn(async () => bot), findMany: vi.fn(async () => [bot]), update },
    executionProfile: { findFirst: vi.fn(async () => profile) },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "membership" })) },
    userModelCredential: {
      findFirst: vi.fn(async () => ({
        id: "account",
        userId: "user",
        provider: "anthropic",
        secretId: "secret",
      })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret" })) },
    computer: { findFirst: vi.fn(async () => ({ id: profileComputerId })) },
  };
  const client = createRouterClient(
    createRouter({
      prisma,
      env: {
        agentRuntime: "pi",
        defaultProvider: "anthropic",
        defaultModel: "model",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps),
    { context: { actor } as never },
  );
  return { client, update, bot };
}

describe("profile computer binding", () => {
  it.each(["other-computer", null])(
    "rejects a computer mismatch before changing the bot (%s)",
    async (current) => {
      const f = fixture("profile-computer", current);
      await expect(
        f.client.bots.update({ botId: "bot", executionProfileId: "profile" }),
      ).rejects.toThrow("bound to another computer");
      expect(f.update).not.toHaveBeenCalled();
      expect(f.bot.executionProfileId).toBeNull();
    },
  );
  it.each(["current-computer", null])(
    "allows a matching explicit or inherited computer (%s)",
    async (profileComputer) => {
      const f = fixture(profileComputer);
      const updated = await f.client.bots.update({ botId: "bot", executionProfileId: "profile" });
      expect(updated.executionProfileId).toBe("profile");
      expect(updated.executionProfile?.computerId).toBe(profileComputer);
      expect(f.update).toHaveBeenCalledOnce();
    },
  );
});

describe("profile-bound bot duplication", () => {
  it("rejects a dedicated duplicate before allocating an unusable computer/profile binding", async () => {
    const f = fixture("current-computer");
    f.bot.executionProfileId = "profile";
    await expect(f.client.bots.duplicate({ botId: "bot" })).rejects.toThrow(
      "computer the duplicate would not use",
    );
    expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects an already-mismatched team profile instead of copying it", async () => {
    const f = fixture("different-computer");
    f.bot.executionProfileId = "profile";
    f.bot.computer.scope = "team";
    await expect(f.client.bots.duplicate({ botId: "bot" })).rejects.toThrow(
      "computer the duplicate would not use",
    );
    expect(f.update).not.toHaveBeenCalled();
  });
});
