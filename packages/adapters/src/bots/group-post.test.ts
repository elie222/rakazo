import { BOT_MESSAGE_MAX_LENGTH, BOT_MESSAGE_TOO_LONG } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findPostableGroup, postToGroup } from "./group-post.js";

const run = {
  id: "run-a",
  spaceId: "space-1",
  threadId: "thread-routine",
  botId: "bot-a",
};
const group = { id: "group-1", name: "Launch" };

function harness(options: { member?: boolean; existing?: { id: string } } = {}) {
  const messageCreate = vi.fn(async (_args: unknown) => ({ id: "message-1" }));
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (..._args: unknown[]) => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        thread: { id: "thread-group" },
        members: options.member === false ? [] : [{ id: "member-a" }],
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findUnique: vi.fn(async () => ({ status: "running", userId: "user-1" })),
      create: vi.fn(),
    },
    task: { create: vi.fn() },
    message: {
      findUnique: vi.fn(async (_args: unknown) => options.existing ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq
          ? { nextMessageSeq: 4, spaceId: "space-1" }
          : { nextEventSeq: 7, spaceId: "space-1" },
      ),
    },
    event: { create: vi.fn(async () => ({ seq: 6 })) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  const deps = { prisma, events: { notify: vi.fn(async () => undefined) } };
  return { deps, tx, messageCreate };
}

describe("posting into a group", () => {
  it("posts the message as the bot's own and signals the group thread", async () => {
    const { deps, tx, messageCreate } = harness();

    await expect(
      postToGroup(deps as never, run, group, {
        message: " Nightly build passed ",
        deliveryKey: "k",
      }),
    ).resolves.toEqual({
      ok: true,
      group: "Launch",
      messageId: "message-1",
      note: "Posted in Launch. It started no member.",
    });

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "thread-group",
        role: "bot",
        botId: "bot-a",
        clientNonce: "group-post:k",
        blocks: [{ kind: "text", text: "Nightly build passed" }],
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", threadId: "thread-group" }),
      }),
    );
    expect(deps.events.notify).toHaveBeenCalledWith("thread-group", expect.any(Number));
  });

  it("starts no other member", async () => {
    const { deps, tx } = harness();

    await postToGroup(deps as never, run, group, { message: "@B take a look" });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it("returns the first post when the same call runs again", async () => {
    const { deps, messageCreate } = harness({ existing: { id: "message-first" } });

    await expect(
      postToGroup(deps as never, run, group, { message: "done", deliveryKey: "k" }),
    ).resolves.toMatchObject({ ok: true, messageId: "message-first" });

    expect(messageCreate).not.toHaveBeenCalled();
    expect(deps.events.notify).not.toHaveBeenCalled();
  });

  it("refuses a bot no longer in the group and posts nothing", async () => {
    const { deps, messageCreate } = harness({ member: false });

    await expect(postToGroup(deps as never, run, group, { message: "hi" })).resolves.toEqual({
      error: "you are not a member of that group",
    });
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("refuses a message over the limit before writing", async () => {
    const { deps } = harness();

    await expect(
      postToGroup(deps as never, run, group, {
        message: "x".repeat(BOT_MESSAGE_MAX_LENGTH + 1),
      }),
    ).resolves.toEqual({ error: BOT_MESSAGE_TOO_LONG });
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("finding the group to post into", () => {
  function prismaWith(joined: unknown[], exists = false) {
    const findMany = vi.fn(async (_args: unknown) => joined);
    const findFirst = vi.fn(async (_args: unknown) => (exists ? { id: "group-x" } : null));
    return {
      prisma: { chatGroup: { findMany, findFirst } } as unknown as PrismaClient,
      findMany,
    };
  }
  const joined = (id: string, threadId = `thread-${id}`) => ({
    id,
    name: "Launch",
    thread: { id: threadId },
  });

  it("finds a group the bot belongs to by exact name", async () => {
    const { prisma, findMany } = prismaWith([joined("group-1")]);

    await expect(findPostableGroup(prisma, run, { groupName: "Launch" })).resolves.toEqual({
      id: "group-1",
      name: "Launch",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          name: "Launch",
          archivedAt: null,
          members: { some: { botId: "bot-a", bot: { archivedAt: null } } },
        }),
      }),
    );
  });

  it("names why it can't post", async () => {
    await expect(
      findPostableGroup(prismaWith([]).prisma, run, { groupName: "Nope" }),
    ).resolves.toEqual({ error: 'no group named "Nope"' });
    await expect(
      findPostableGroup(prismaWith([], true).prisma, run, { groupId: "group-1" }),
    ).resolves.toEqual({ error: "you are not a member of that group" });
    await expect(
      findPostableGroup(prismaWith([joined("group-1"), joined("group-2")]).prisma, run, {
        groupName: "Launch",
      }),
    ).resolves.toEqual({
      error: 'more than one of your groups is named "Launch"; pass group_id',
    });
    await expect(
      findPostableGroup(prismaWith([joined("group-1", run.threadId)]).prisma, run, {
        groupId: "group-1",
      }),
    ).resolves.toEqual({ error: "you are already in this group; reply here instead" });
    await expect(findPostableGroup(prismaWith([]).prisma, run, {})).resolves.toEqual({
      error: "pass group_id or group_name",
    });
  });
});
