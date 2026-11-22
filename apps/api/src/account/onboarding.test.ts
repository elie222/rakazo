import type * as db from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, dismissFocus, markAppConnected, promptFocus } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[]; markUnread?: boolean }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
const queueConnectedRun = vi.hoisted(() => vi.fn(async () => "carry-on"));
vi.mock("../integrations/connected-run.js", () => ({ queueConnectedRun }));
// These transactions lock the thread row, which snapshot reads hold for up to 15s.
const budget = { timeout: 20_000 };
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [{ id: "choice", blocks: [{ kind: "choice", answerId: null }] }]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    jobs: { enqueue: vi.fn() },
    connectors: {
      defaultConnectorId: "first-connector",
      managedProviders: () => [{ catalog: async () => catalog }],
      managed: vi.fn(() => ({ catalog: async () => catalog })),
    },
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
    // The reply to the user's pick is read; suggestions after the catalog wait stay unread.
    expect(posted[0]?.markUnread).toBe(false);
    expect(posted.slice(1).every((message) => message.markUnread === true)).toBe(true);
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), budget);
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

describe("promptFocus", () => {
  function focusFixture(options: { introRun?: boolean; blocks?: unknown[] } = {}) {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany = vi.fn(async () =>
      options.blocks ? [{ role: "bot", blocks: options.blocks }] : [],
    ) as never;
    const run = {
      findFirst: vi.fn(async () => (options.introRun ? { id: "intro" } : null)),
    };
    Object.assign(tx, { run });
    return { deps, actor, run };
  }

  it("posts the fixed focus card when the bot has no creation intro", async () => {
    const { deps, actor } = focusFixture();
    await promptFocus(deps, actor, "bot");
    expect(posted.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ kind: "choice" }),
    );
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("leaves the question to a bot whose creation intro is queued or running", async () => {
    const { deps, actor, run } = focusFixture({ introRun: true });
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([]);
    expect(run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread", trigger: "created" }),
      }),
    );
  });

  it("does not post over a question the bot already asked", async () => {
    const { deps, actor } = focusFixture({
      blocks: [{ kind: "ask", text: "What do you want me for?", status: "answered" }],
    });
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
  ]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  tx.message.findMany = vi.fn(async () => [{ id: "cards", blocks }]) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
  expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), budget);
});

it("reads a request and a stored card that name no connector as the server's default", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "first-connector", slug: "slack", name: "Slack", connected: true },
  ]);
  const card = { kind: "app_connect", provider: "slack", name: "Slack", status: "pending" };
  const other = { ...card, connectorId: "pipedream" };
  tx.message.findMany = vi.fn(async () => [{ id: "cards", blocks: [card, other] }]) as never;
  await markAppConnected(deps, actor, "bot", "slack", undefined);
  expect(deps.connectors.managed).toHaveBeenCalledWith("first-connector");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [{ ...card, status: "connected" }, other] },
  });
});

it("dismisses the pending focus card under the thread-lock budget", async () => {
  const { deps, actor, tx } = fixture([]);
  await dismissFocus(deps, actor, "bot");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "choice" },
    data: { blocks: [{ kind: "choice", answerId: expect.any(String) }] },
  });
  expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), budget);
});

it("does not trust a client's connected claim", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: false },
  ]);
  Object.assign(deps.prisma, { message: { findMany: vi.fn() } });
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread");
  expect(deps.prisma.message.findMany).not.toHaveBeenCalled();
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("rejects a thread from another user or space before reading its messages", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, { thread: { findFirst: vi.fn(async () => null) } });
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "other-thread"),
  ).rejects.toThrow();
  expect(deps.prisma.thread.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "other-thread", spaceId: actor.spaceId } }),
  );
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("updates an accessible group thread and emits its normal update event", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({ id: "group-thread", groupId: "group" })),
    },
  });
  Object.assign(deps.prisma, {
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group",
        name: "Team",
        thread: { id: "group-thread" },
        members: ["bot", "peer"].map((id) => ({ bot: { id, name: id, runs: [] } })),
      })),
    },
  });
  tx.message.findMany = vi.fn(async () => [
    {
      id: "card",
      blocks: [
        { kind: "app_connect", connectorId: "pipedream", provider: "slack", status: "pending" },
      ],
    },
  ]) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "group-thread");
  expect(deps.prisma.chatGroup.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "group", spaceId: actor.spaceId, archivedAt: null },
    }),
  );
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { threadId: "group-thread" } }),
  );
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "card" },
    data: { blocks: [expect.objectContaining({ status: "connected" })] },
  });
  expect(appendEventInTransaction).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      threadId: "group-thread",
      spaceId: actor.spaceId,
      type: "thread.message.updated",
    }),
  );
  expect(deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
});

it("updates a card in a topic of the bot's own chat", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({
        id: "topic",
        groupId: null,
        parentMessage: { thread: { id: "thread", groupId: null } },
      })),
    },
  });
  tx.message.findMany = vi.fn(async () => [
    {
      id: "card",
      blocks: [
        { kind: "app_connect", connectorId: "pipedream", provider: "slack", status: "pending" },
      ],
    },
  ]) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "topic");
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { threadId: "topic" } }),
  );
  expect(tx.message.update).toHaveBeenCalled();
});

it("rejects a topic of a chat the bot is not in", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({
        id: "topic",
        groupId: null,
        parentMessage: { thread: { id: "someone-elses", groupId: null } },
      })),
    },
  });
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "topic"),
  ).rejects.toThrow();
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("rejects a group the space does not have", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({ id: "other-thread", groupId: "other-group" })),
    },
  });
  Object.assign(deps.prisma, { chatGroup: { findFirst: vi.fn(async () => null) } });
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "other-thread"),
  ).rejects.toThrow();
  expect(tx.message.update).not.toHaveBeenCalled();
  expect(deps.prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "bot", spaceId: actor.spaceId } }),
  );
});

it("updates the authorized card's own message even outside the bounded scan", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
  ]);
  const card = {
    kind: "app_connect",
    connectorId: "pipedream",
    provider: "slack",
    name: "Slack",
    status: "pending",
  };
  tx.message.findMany = vi.fn(async ({ where }: { where: { id?: string; threadId: string } }) =>
    where.id === "middle" && where.threadId === "thread" ? [{ id: "middle", blocks: [card] }] : [],
  ) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "middle");
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "middle", threadId: "thread" } }),
  );
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "middle" },
    data: { blocks: [{ ...card, status: "connected" }] },
  });
});

describe("after a card connects its app", () => {
  const card = {
    kind: "app_connect",
    connectorId: "pipedream",
    provider: "slack",
    name: "Slack",
    status: "pending",
  };
  function connected(message: { runId: string | null; botId?: string }) {
    queueConnectedRun.mockClear();
    const setup = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
    ]);
    setup.tx.message.findMany = vi.fn(async () => [
      { id: "card", blocks: [card], botId: "bot", ...message },
    ]) as never;
    return setup;
  }

  it("lets the bot that asked for it carry on", async () => {
    const { deps, actor, tx } = connected({ runId: "asked" });
    await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "card");
    expect(queueConnectedRun).toHaveBeenCalledWith(tx, actor, {
      botId: "bot",
      threadId: "thread",
      prompt: expect.stringContaining('"Slack"'),
    });
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "carry-on" } }),
    );
  });

  it("takes the server's word for a connection it made itself, without asking the provider", async () => {
    const { deps, actor } = connected({ runId: "asked" });
    await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "card", true);
    expect(deps.connectors.managed).not.toHaveBeenCalled();
    expect(queueConnectedRun).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ prompt: expect.stringContaining('"Slack"') }),
    );
  });

  it("starts no turn for onboarding's own cards", async () => {
    const { deps, actor } = connected({ runId: null });
    await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "card");
    expect(queueConnectedRun).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("starts no turn for another bot than the one whose card it is", async () => {
    const { deps, actor } = connected({ runId: "asked", botId: "peer" });
    await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "card");
    expect(queueConnectedRun).not.toHaveBeenCalled();
  });

  it("starts no turn when connected from somewhere other than the bot's card", async () => {
    const { deps, actor } = connected({ runId: "asked" });
    await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread");
    expect(queueConnectedRun).not.toHaveBeenCalled();
  });
});
