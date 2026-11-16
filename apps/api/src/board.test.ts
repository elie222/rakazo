import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("ticket board off for the account", () => {
  it.each([[], ["unknown"]])(
    "refuses every route and stream after reading only the account's labs (%j)",
    async (...labs) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const findUnique = vi.fn(async () => ({ labs }));
      const follow = vi.fn();
      const prisma = new Proxy(
        { user: { findUnique } },
        { get: (target, key) => (key === "user" ? target.user : query) },
      );
      const client = createRouterClient(
        createRouter({ prisma, env: {}, boardEvents: { follow } } as unknown as RouterDeps),
        { context: { actor } },
      );
      const calls = [
        () => client.boards.list(),
        () => client.boards.get(),
        () => client.boards.rename({ name: "Launch" }),
        () => client.boards.subscribe(),
        () => client.tickets.list({}),
        () => client.tickets.get({ id: "ticket-1" }),
        () => client.tickets.create({ title: "Launch", assigneeBotId: "bot-1" }),
        () => client.tickets.update({ id: "ticket-1", assigneeBotId: "bot-1" }),
        () => client.tickets.move({ id: "ticket-1", status: "doing" }),
        () => client.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
        () => client.tickets.comments({ ticketId: "ticket-1" }),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: actor.userId },
        select: { labs: true },
      });
      expect(query).not.toHaveBeenCalled();
      expect(follow).not.toHaveBeenCalled();
    },
  );
});

it("rejects an out-of-range ticket reference before querying tickets", async () => {
  const findFirst = vi.fn(async () => null);
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ labs: ["board"] })) },
    board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
    ticket: { findFirst },
  };
  const client = createRouterClient(createRouter({ prisma, env: {} } as unknown as RouterDeps), {
    context: { actor },
  });

  await expect(client.tickets.get({ ref: `RAK-${"9".repeat(115)}` })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Invalid ticket reference.",
  });
  expect(findFirst).not.toHaveBeenCalled();
});

it("refuses a signed-out caller before querying the board", async () => {
  const findUnique = vi.fn();
  const client = createRouterClient(
    createRouter({
      prisma: { board: { findUnique }, user: { findUnique } },
      env: {},
    } as unknown as RouterDeps),
    { context: { actor: null } },
  );
  await expect(client.boards.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(findUnique).not.toHaveBeenCalled();
});

it("serves the board to every account without reading labs when the deployment turns it on", async () => {
  const userLookup = vi.fn();
  const prisma = {
    user: { findUnique: userLookup },
    board: {
      findUnique: vi.fn(async () => ({
        id: "board-1",
        spaceId: actor.spaceId,
        name: "Board",
        ticketPrefix: "RAK",
        nextNumber: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    },
  };
  const client = createRouterClient(
    createRouter({ prisma, env: { deploymentLabs: ["board"] } } as unknown as RouterDeps),
    { context: { actor } },
  );
  await expect(client.boards.get()).resolves.toBeDefined();
  expect(userLookup).not.toHaveBeenCalled();
});

function meDeps(labs: string[], deploymentLabs: string[] = []) {
  let saved = labs;
  const update = vi.fn(async ({ data }: { data: { labs?: string[] } }) => {
    if (data.labs) saved = data.labs;
    return {};
  });
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "user@rakazo.test",
        name: "Test",
        avatarStyle: "robot",
        labs: saved,
        secrets: [],
      })),
      update,
    },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
  };
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
      deploymentLabs,
    },
  } as unknown as RouterDeps;
  return { client: createRouterClient(createRouter(deps), { context: { actor } }), update };
}

it.each([
  [[], [], false],
  [["board"], ["board"], true],
  [["retired", "board"], ["board"], true],
])("reports the account's labs in me (%j)", async (stored, labs, ticketBoardEnabled) => {
  const { client } = meDeps(stored);
  await expect(client.me()).resolves.toMatchObject({
    labs,
    labsAvailable: ["board"],
    ticketBoardEnabled,
  });
});

it("reports a feature the deployment turns on as on and not switchable", async () => {
  const { client } = meDeps([], ["board"]);
  await expect(client.me()).resolves.toMatchObject({
    labs: ["board"],
    labsAvailable: [],
    ticketBoardEnabled: true,
  });
});

it("saves the account's labs once each and reports them back", async () => {
  const { client, update } = meDeps([]);
  await expect(client.preferences.update({ labs: ["board", "board"] })).resolves.toMatchObject({
    labs: ["board"],
    ticketBoardEnabled: true,
  });
  expect(update).toHaveBeenCalledWith({
    where: { id: actor.userId },
    data: { labs: ["board"] },
  });
  await expect(client.preferences.update({ labs: [] })).resolves.toMatchObject({
    labs: [],
    ticketBoardEnabled: false,
  });
});

it("does not save a feature the deployment turns on as the account's choice", async () => {
  const { client, update } = meDeps([], ["board"]);
  await expect(client.preferences.update({ labs: ["board"] })).resolves.toMatchObject({
    labs: ["board"],
  });
  expect(update).toHaveBeenCalledWith({ where: { id: actor.userId }, data: { labs: [] } });
});
