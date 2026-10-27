import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireDeploymentCatalogAdmin = vi.hoisted(() => vi.fn(async () => undefined));
const requireSpaceOwnerRole = vi.hoisted(() => vi.fn(async () => undefined));
const catalog = vi.hoisted(() => ({
  listPublishedGlobalBots: vi.fn(async () => [{ id: "g1", slug: "dana" }]),
  getGlobalBot: vi.fn(async () => ({ id: "g1", slug: "dana" })),
  createGlobalBot: vi.fn(async (input: { slug: string }) => ({ id: "g1", ...input })),
  updateGlobalBot: vi.fn(async (input: { globalBotId: string }) => ({ id: input.globalBotId })),
  publishGlobalBot: vi.fn(async (id: string) => ({ id, publishedAt: "2026-10-28T00:00:00.000Z" })),
  setGlobalBotConnectors: vi.fn(async (id: string, connectorIds: string[]) => ({
    id,
    connectorIds,
  })),
  listConnectors: vi.fn(async () => []),
  getConnector: vi.fn(async (id: string) => ({ id })),
  createConnector: vi.fn(async (input: { slug: string }) => ({ id: "c1", ...input })),
  updateConnector: vi.fn(async (input: { connectorId: string }) => ({ id: input.connectorId })),
  removeConnector: vi.fn(async () => undefined),
  listSpaceGlobalBots: vi.fn(async () => []),
  setSpaceGlobalBotEnabled: vi.fn(async () => ({ globalBotId: "g1", enabled: true })),
  getSpacePermissions: vi.fn(async () => ({ roles: [] })),
  setSpacePermissions: vi.fn(async () => ({ roles: [] })),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    createGlobalBotRepos: () => catalog,
    requireDeploymentCatalogAdmin,
    requireSpaceOwnerRole,
  };
});

import { globalBotsRoutes } from "./global-bots.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
  role: "owner",
};

function wrapAuthed() {
  const wrap = (fn: unknown) => ({ handler: fn });
  return {
    globalBots: {
      listPublished: { handler: wrap },
      get: { handler: wrap },
      admin: {
        create: { handler: wrap },
        update: { handler: wrap },
        publish: { handler: wrap },
        setConnectors: { handler: wrap },
      },
    },
    connectors: {
      admin: {
        list: { handler: wrap },
        get: { handler: wrap },
        create: { handler: wrap },
        update: { handler: wrap },
        remove: { handler: wrap },
      },
    },
    spaceGlobalBots: {
      list: { handler: wrap },
      setEnabled: { handler: wrap },
    },
    spacePermissions: {
      get: { handler: wrap },
      set: { handler: wrap },
    },
  };
}

function handlerOf(route: { handler: (input: unknown) => unknown }) {
  return route.handler as (args: {
    context: { actor: Actor };
    input?: unknown;
  }) => Promise<unknown>;
}

describe("globalBotsRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDeploymentCatalogAdmin.mockResolvedValue(undefined);
    requireSpaceOwnerRole.mockResolvedValue(undefined);
  });

  it("lists published globals without an admin gate", async () => {
    const routes = globalBotsRoutes({
      deps: { prisma: {} },
      authed: wrapAuthed(),
    } as never);

    await expect(handlerOf(routes.globalBots.listPublished)({ context: { actor } })).resolves.toEqual([
      { id: "g1", slug: "dana" },
    ]);
    expect(requireDeploymentCatalogAdmin).not.toHaveBeenCalled();
  });

  it("gates catalog writes on deployment admin", async () => {
    requireDeploymentCatalogAdmin.mockRejectedValueOnce(
      new IsolationError("Deployment admin required"),
    );
    const routes = globalBotsRoutes({
      deps: { prisma: {} },
      authed: wrapAuthed(),
    } as never);

    await expect(
      handlerOf(routes.globalBots.admin.create)({
        context: { actor },
        input: { slug: "dana", name: "Dana", color: "#3EC5A8" },
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(catalog.createGlobalBot).not.toHaveBeenCalled();
  });

  it("gates space enablement on space owner", async () => {
    requireSpaceOwnerRole.mockRejectedValueOnce(new IsolationError("Space owner required"));
    const routes = globalBotsRoutes({
      deps: { prisma: {} },
      authed: wrapAuthed(),
    } as never);

    await expect(
      handlerOf(routes.spaceGlobalBots.setEnabled)({
        context: { actor: { ...actor, role: "member" } },
        input: { globalBotId: "g1", enabled: true },
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(catalog.setSpaceGlobalBotEnabled).not.toHaveBeenCalled();
  });
});
