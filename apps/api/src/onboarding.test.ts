import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [{ id: "choice", blocks: [{ kind: "choice", answerId: null }] }]),
      update: vi.fn((_input: { where: { id: string }; data: unknown }) => undefined),
    },
  };
  const deps = {
    prisma: {
      connection: { findMany: vi.fn(async () => [{ provider: "GMAIL" }, { provider: "SLACK" }]) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  deps.prisma.message = { findMany: vi.fn(async () => [{ id: "cards", blocks }]) } as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
});

it("flips only the named card, in the thread where it was posted", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["Gmail", "Gmail · Work"].map((name) => ({
    kind: "app_connect",
    connectorId: "composio",
    provider: "gmail",
    name,
    status: "pending",
  }));
  deps.prisma.message = {
    findMany: vi.fn(async () => [{ id: "cards", threadId: "group-thread", blocks }]),
  } as never;
  await markAppConnected(deps, actor, "bot", "gmail", "composio", "Gmail · Work");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
  expect(deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
});

it("scopes candidate cards to the actor's space and owned internal threads", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = [
    {
      kind: "app_connect",
      connectorId: "composio",
      provider: "gmail",
      name: "Gmail",
      status: "pending",
    },
  ];
  const messages = [
    {
      id: "primary",
      threadId: "thread",
      botId: null,
      blocks,
      thread: { spaceId: actor.spaceId, userId: actor.userId, externalConversationId: null },
    },
    {
      id: "group",
      threadId: "group-thread",
      botId: "bot",
      blocks,
      thread: { spaceId: actor.spaceId, userId: actor.userId, externalConversationId: null },
    },
    {
      id: "other-user",
      threadId: "other-thread",
      botId: "bot",
      blocks,
      thread: { spaceId: actor.spaceId, userId: "other-user", externalConversationId: null },
    },
    {
      id: "other-space",
      threadId: "other-space-thread",
      botId: "bot",
      blocks,
      thread: { spaceId: "other-space", userId: actor.userId, externalConversationId: null },
    },
    {
      id: "external",
      threadId: "external-thread",
      botId: "bot",
      blocks,
      thread: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        externalConversationId: "conversation",
      },
    },
  ];
  const findMany = vi.fn(async ({ where }) =>
    messages.filter(
      (message) =>
        Object.entries(where.thread).every(
          ([key, value]) => message.thread[key as keyof typeof message.thread] === value,
        ) &&
        where.OR.some(
          (condition: { threadId?: string; botId?: string }) =>
            condition.threadId === message.threadId || condition.botId === message.botId,
        ),
    ),
  );
  deps.prisma.message = { findMany } as never;
  await markAppConnected(deps, actor, "bot", "gmail");
  expect(findMany).toHaveBeenCalledWith({
    where: {
      thread: { spaceId: actor.spaceId, userId: actor.userId, externalConversationId: null },
      OR: [{ threadId: "thread" }, { botId: "bot" }],
    },
    select: { id: true, threadId: true, blocks: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  expect(tx.message.update.mock.calls.map(([input]) => input.where.id)).toEqual([
    "primary",
    "group",
  ]);
  expect(deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
  expect(deps.prisma.connection.findMany).toHaveBeenCalledWith({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      connectorId: "composio",
      status: "connected",
    },
    select: { provider: true },
  });
});

it("does not flip cards without a connected account for the provider", async () => {
  const { deps, actor, tx } = fixture([]);
  deps.prisma.connection.findMany = vi.fn(async () => [{ provider: "slack" }]) as never;
  deps.prisma.message = { findMany: vi.fn() } as never;
  await markAppConnected(deps, actor, "bot", "gmail");
  expect(deps.prisma.message.findMany).not.toHaveBeenCalled();
  expect(tx.message.update).not.toHaveBeenCalled();
});
