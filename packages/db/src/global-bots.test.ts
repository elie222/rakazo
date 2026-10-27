import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  botRosterWhere,
  createGlobalBotRepos,
  requireDeploymentCatalogAdmin,
  requireSpaceOwnerRole,
} from "./global-bots.js";
import { IsolationError } from "./scope.js";

const owner: Actor = {
  userId: "user-owner",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
  role: "owner",
};

const member: Actor = {
  ...owner,
  userId: "user-member",
  email: "member@example.test",
  role: "member",
};

describe("requireSpaceOwnerRole", () => {
  it("allows owners and rejects members", async () => {
    await expect(requireSpaceOwnerRole(owner)).resolves.toBeUndefined();
    await expect(requireSpaceOwnerRole(member)).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("requireDeploymentCatalogAdmin", () => {
  it("allows the recorded owner", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: owner.userId })),
        updateMany: vi.fn(),
      },
    };
    await expect(
      requireDeploymentCatalogAdmin(prisma as never, owner),
    ).resolves.toBeUndefined();
    expect(prisma.deploymentSettings.updateMany).not.toHaveBeenCalled();
  });

  it("claims ownership when unset", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    await expect(
      requireDeploymentCatalogAdmin(prisma as never, owner),
    ).resolves.toBeUndefined();
    expect(prisma.deploymentSettings.updateMany).toHaveBeenCalledWith({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: owner.userId },
    });
  });

  it("rejects a different recorded owner", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: "someone-else" })),
        updateMany: vi.fn(),
      },
    };
    await expect(requireDeploymentCatalogAdmin(prisma as never, owner)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});

describe("botRosterWhere", () => {
  it("includes shared Global instances for the active roster", () => {
    expect(botRosterWhere(member)).toEqual({
      spaceId: member.spaceId,
      archivedAt: null,
      OR: [{ userId: member.userId }, { userId: null, globalBotId: { not: null } }],
    });
  });

  it("keeps archived lists personal-only", () => {
    expect(botRosterWhere(member, { archived: true })).toEqual({
      spaceId: member.spaceId,
      userId: member.userId,
      archivedAt: { not: null },
    });
  });
});

describe("createGlobalBotRepos mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists published bots with connector order", async () => {
    const prisma = {
      globalBot: {
        findMany: vi.fn(async () => [
          {
            id: "g1",
            slug: "dana",
            name: "Dana",
            title: "Finance",
            description: "",
            instructions: "",
            color: "#3EC5A8",
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
            disabledBuiltinTools: [],
            publishedAt: new Date("2026-10-28T00:00:00.000Z"),
            createdAt: new Date("2026-10-28T00:00:00.000Z"),
            updatedAt: new Date("2026-10-28T00:00:00.000Z"),
            connectors: [
              { connectorId: "c2", position: 1 },
              { connectorId: "c1", position: 0 },
            ],
          },
        ]),
      },
    };
    const repos = createGlobalBotRepos(prisma as never);
    await expect(repos.listPublishedGlobalBots()).resolves.toMatchObject([
      { id: "g1", slug: "dana", connectorIds: ["c1", "c2"] },
    ]);
  });

  it("maps space enablements onto published catalog rows", async () => {
    const prisma = {
      globalBot: {
        findMany: vi.fn(async () => [
          {
            id: "g1",
            slug: "dana",
            name: "Dana",
            title: "",
            description: "",
            color: "#3EC5A8",
            publishedAt: new Date("2026-10-28T00:00:00.000Z"),
          },
        ]),
      },
      spaceGlobalBot: {
        findMany: vi.fn(async () => [
          {
            globalBotId: "g1",
            enabledAt: new Date("2026-10-28T01:00:00.000Z"),
          },
        ]),
      },
      bot: {
        findMany: vi.fn(async () => [{ id: "b1", globalBotId: "g1", archivedAt: null }]),
      },
    };
    const repos = createGlobalBotRepos(prisma as never);
    await expect(repos.listSpaceGlobalBots(owner)).resolves.toEqual([
      {
        globalBotId: "g1",
        botId: "b1",
        enabled: true,
        enabledAt: "2026-10-28T01:00:00.000Z",
        slug: "dana",
        name: "Dana",
        title: "",
        description: "",
        color: "#3EC5A8",
        publishedAt: "2026-10-28T00:00:00.000Z",
      },
    ]);
  });
});
