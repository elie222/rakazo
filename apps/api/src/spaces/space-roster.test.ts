import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, Bot, SpaceNavigation } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

it("keeps instruction history out of the roster and returns it on the single-bot read", async () => {
  const createdAt = new Date("2026-08-19T00:00:00Z");
  const color = `data:image/png;base64,${"aGVsbG8=".repeat(2000)}`;
  const instructionHistory = Array.from({ length: 20 }, (_, index) => ({
    id: `version-${index}`,
    instructions: "Past instructions. ".repeat(125),
    createdAt: createdAt.toISOString(),
    reason: "Manual edit",
  }));
  const bots = Array.from({ length: 20 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Bot ${index}`,
    spaceId: actor.spaceId,
    description: "",
    instructions: "Current instructions",
    instructionHistory,
    color,
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    parentBotId: null,
    memoryScope: null,
    createdAt,
    updatedAt: createdAt,
    thread: { id: `thread-${index}`, reads: [] },
    runs: [],
    computer: null,
  }));
  const findMany = vi.fn(async ({ where }: { where: { id?: string } }) =>
    where.id ? bots.filter((bot) => bot.id === where.id) : bots,
  );
  const deps = {
    env: {},
    prisma: {
      spaceMember: {
        findUnique: async () => ({ organizationId: "org-1", member: { role: "owner" } }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              spaceId: actor.spaceId,
              role: "owner",
              space: {
                name: "Home",
                isDefault: true,
                deletingAt: null,
                _count: { memberships: 1 },
              },
            },
          ])
          .mockResolvedValue([]),
      },
      bot: {
        findMany,
        groupBy: async () => [{ spaceId: actor.spaceId, _count: { _all: bots.length } }],
      },
      chatGroup: { findMany: async () => [] },
      botSection: { findMany: async () => [] },
      externalConversation: { findMany: async () => [] },
      botDeletion: { groupBy: async () => [] },
      $queryRaw: async () => [],
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));

  async function call<T>(path: string, input: object): Promise<T> {
    const { response } = await handler.handle(
      new Request(`http://localhost/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response?.status).toBe(200);
    const body = await response!.text();
    return (JSON.parse(body) as { json: T }).json;
  }

  const roster = await call<SpaceNavigation>("spaces/list", {});
  expect(roster.current.bots).toHaveLength(bots.length);
  expect(roster.current.bots[0]?.color).toBe(color);
  expect(roster.spaces[0]?.bots[0]?.color).toBe(color);
  expect(
    [...roster.current.bots, ...(roster.spaces[0]?.bots ?? [])].filter((bot) =>
      Object.hasOwn(bot, "instructionHistory"),
    ).length,
  ).toBe(0);
  expect(findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ omit: { instructionHistory: true } }),
  );

  const bot = await call<Bot>("bots/get", { botId: bots[0]!.id });
  expect(bot.instructionHistory).toEqual(instructionHistory);
  expect(findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ id: bot.id }) }),
  );
});
