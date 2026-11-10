import type { NotificationMessage } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { notifyMemberMessage, notifyRun } from "./run-notifications.js";

vi.mock("./notification-identity.js", () => ({ notificationIdentity: async () => undefined }));
// What each person set on the chat; anyone missing never chose.
const holds = vi.hoisted(
  () => new Map<string, { snoozed: boolean; hidden: boolean; muted: boolean | null }>(),
);
const unhidden = vi.hoisted(() => [] as string[]);
// Each person's own unread count: Ada has 2 unread chats, Bea 5.
vi.mock("@rakazo/db", () => ({
  countUnreadInboxChats: async (_: unknown, { userId }: { userId: string }) =>
    userId === "user-1" ? 2 : 5,
  chatHoldsFor: async (_: unknown, _threadId: string, userIds: string[]) =>
    new Map(userIds.flatMap((userId) => (holds.has(userId) ? [[userId, holds.get(userId)]] : []))),
  chatMutedByDefault: (bot?: { notifyOnFinish: boolean } | null) =>
    bot ? !bot.notifyOnFinish : false,
  unhideChatFor: async (_: unknown, _threadId: string, userId: string) => {
    unhidden.push(userId);
  },
}));
const hold = (userId: string, set: { snoozed?: boolean; hidden?: boolean; muted?: boolean }) =>
  holds.set(userId, { snoozed: false, hidden: false, muted: null, ...set });
afterEach(() => {
  holds.clear();
  unhidden.length = 0;
});

const run = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  trigger: "user",
};

const message: NotificationMessage = {
  kind: "completion",
  title: "Scout finished",
  body: "The report is ready.",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
};

function deps({
  notifyOnFinish = true,
  groupId = null as string | null,
  publish = vi.fn(async () => undefined),
  members = ["user-1"],
} = {}) {
  const send = vi.fn(async () => undefined);
  const value = {
    prisma: {
      spaceMember: {
        findMany: async ({ where }: { where: { spaceId: string } }) =>
          where.spaceId === "space-1" ? members.map((userId) => ({ userId })) : [],
      },
      thread: {
        findFirst: async () => ({
          bot: { id: "bot-1", name: "Scout", color: "#000000", avatarSet: "", notifyOnFinish },
          group: null,
          groupId,
        }),
      },
      user: { findUnique: async () => ({ name: "Ada" }) },
      routine: { findUnique: async () => null },
      run: {
        findFirst: async () => ({
          bot: { id: "bot-1", name: "Scout", color: "#000000", avatarSet: "", notifyOnFinish },
          thread: { groupId },
        }),
      },
    },
    events: { publishChatAlert: publish },
    notifications: { send },
  } as unknown as ExecutorDeps;
  return { value, publish, send };
}

describe("notifyRun chat alerts", () => {
  it("publishes the alert for open apps alongside the push", async () => {
    const { value, publish, send } = deps();
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledWith("user-1", {
      kind: "completion",
      title: "Scout finished",
      body: "The report is ready.",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("names the group a bot's alert came from", async () => {
    const { value, publish } = deps({ notifyOnFinish: false, groupId: "group-1" });
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledWith("user-1", expect.objectContaining({ groupId: "group-1" }));
  });

  it("publishes nothing for a muted chat", async () => {
    const { value, publish, send } = deps({ notifyOnFinish: false });
    await notifyRun(value, run, message);
    expect(publish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("never holds up or blocks the push", async () => {
    const { value, send } = deps({ publish: vi.fn(() => new Promise<undefined>(() => {})) });
    await notifyRun(value, run, message);
    expect(send).toHaveBeenCalledOnce();
    const failing = deps({ publish: vi.fn(async () => Promise.reject(new Error("down"))) });
    await notifyRun(failing.value, run, message);
    expect(failing.send).toHaveBeenCalledOnce();
  });

  it("still pushes where open apps have no alert publisher", async () => {
    const { value, send } = deps();
    delete (value.events as { publishChatAlert?: unknown }).publishChatAlert;
    await notifyRun(value, run, message);
    expect(send).toHaveBeenCalledOnce();
  });

  it("publishes even where phones have no push provider", async () => {
    const { value, publish } = deps();
    delete (value as { notifications?: unknown }).notifications;
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledOnce();
  });
});

// Ada (user-1) and Bea (user-2) share space-1; nobody else is in it.
describe("notifications in a shared Space", () => {
  const shared = ["user-1", "user-2"];
  const recipients = (send: ReturnType<typeof deps>["send"]) =>
    send.mock.calls
      .map((call) => (call as unknown[])[1] as { userId: string })
      .map((c) => c.userId);

  it("tells everyone about a reply, each with their own unread count", async () => {
    const { value, publish, send } = deps({ members: shared });
    await notifyRun(value, run, message);
    expect(recipients(send).sort()).toEqual(["user-1", "user-2"]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ badge: 2 }),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ badge: 5 }),
      expect.objectContaining({ userId: "user-2" }),
    );
    expect(publish.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("reaches every member of a larger Space, a few at a time", async () => {
    const many = Array.from({ length: 12 }, (_, index) => `user-${index + 1}`);
    const { value, send } = deps({ members: many });
    await notifyRun(value, run, message);
    expect(recipients(send).sort()).toEqual([...many].sort());
  });

  it("keeps a reply to another bot with the person whose run it is", async () => {
    const { value, send } = deps({ members: shared });
    await notifyRun(value, { ...run, trigger: "bot_message" }, message);
    expect(recipients(send)).toEqual(["user-1"]);
  });

  it("holds a reply for whoever snoozed the chat, but still asks its owner to answer", async () => {
    hold("user-1", { snoozed: true });
    const { value, publish, send } = deps({ members: shared });
    await notifyRun(value, run, message);
    expect(recipients(send)).toEqual(["user-2"]);
    expect(publish.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["user-2"]);

    const help = deps({ members: shared });
    await notifyRun(help.value, run, { ...message, kind: "help" });
    expect(recipients(help.send)).toEqual(["user-1"]);
  });

  it("holds a reply for whoever muted the chat, a group included", async () => {
    hold("user-2", { muted: true });
    for (const groupId of [null, "group-1"]) {
      const { value, publish, send } = deps({ members: shared, groupId });
      await notifyRun(value, run, message);
      expect(recipients(send)).toEqual(["user-1"]);
      expect(publish.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["user-1"]);
    }
  });

  it("still brings its owner a muted chat's questions, takeovers and failures", async () => {
    hold("user-1", { muted: true });
    for (const kind of ["help", "takeover", "failure"] as const) {
      const { value, send } = deps({ members: shared });
      await notifyRun(value, run, { ...message, kind });
      expect(recipients(send)).toEqual(["user-1"]);
    }
  });

  it("keeps a bot's own switch for whoever never chose, and lets each member choose", async () => {
    hold("user-2", { muted: false });
    const { value, send } = deps({ members: shared, notifyOnFinish: false });
    await notifyRun(value, run, message);
    expect(recipients(send)).toEqual(["user-2"]);

    // Its owner never chose, so the switch still silences their questions too, as it always did.
    const help = deps({ members: shared, notifyOnFinish: false });
    await notifyRun(help.value, run, { ...message, kind: "help" });
    expect(help.send).not.toHaveBeenCalled();
    hold("user-1", { muted: true });
    await notifyRun(help.value, run, { ...message, kind: "help" });
    expect(recipients(help.send)).toEqual(["user-1"]);
  });

  it("holds a hidden chat's replies and brings it back when it needs its owner", async () => {
    hold("user-1", { hidden: true });
    const { value, send } = deps({ members: shared });
    await notifyRun(value, run, message);
    expect(recipients(send)).toEqual(["user-2"]);
    expect(unhidden).toEqual([]);

    const help = deps({ members: shared });
    await notifyRun(help.value, run, { ...message, kind: "help" });
    expect(recipients(help.send)).toEqual(["user-1"]);
    expect(unhidden).toEqual(["user-1"]);
  });

  it("brings back a hidden chat whose bot is silent by its own switch, without a push", async () => {
    hold("user-1", { hidden: true });
    const { value, send, publish } = deps({ notifyOnFinish: false });
    await notifyRun(value, run, { ...message, kind: "help" });
    expect(unhidden).toEqual(["user-1"]);
    expect(send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("brings a hidden chat back even where nobody can be alerted", async () => {
    hold("user-1", { hidden: true });
    const { value } = deps();
    delete (value as { notifications?: unknown }).notifications;
    delete (value.events as { publishChatAlert?: unknown }).publishChatAlert;
    await notifyRun(value, run, { ...message, kind: "takeover" });
    expect(unhidden).toEqual(["user-1"]);
  });

  it("asks only the person whose run it is to answer, take over, or fix a failure", async () => {
    for (const kind of ["help", "takeover", "failure"] as const) {
      const { value, publish, send } = deps({ members: shared });
      await notifyRun(value, run, { ...message, kind });
      expect(recipients(send)).toEqual(["user-1"]);
      expect(publish.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["user-1"]);
    }
  });

  it("pushes Ada's message to Bea, never to Ada or someone outside the Space", async () => {
    const { value, publish, send } = deps({ members: shared });
    await notifyMemberMessage(value, {
      spaceId: "space-1",
      threadId: "thread-1",
      authorUserId: "user-1",
      text: "Can you plan dinner for Saturday?",
    });
    expect(recipients(send)).toEqual(["user-2"]);
    expect(send).toHaveBeenCalledWith(
      {
        kind: "completion",
        title: "Scout",
        body: "Ada: Can you plan dinner for Saturday?",
        botId: "bot-1",
        threadId: "thread-1",
        badge: 5,
      },
      expect.objectContaining({ userId: "user-2", spaceId: "space-1" }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "user-2",
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("skips whoever muted the chat when another member writes in it", async () => {
    hold("user-2", { muted: true });
    const { value, send } = deps({ members: [...shared, "user-3"], groupId: "group-1" });
    await notifyMemberMessage(value, {
      spaceId: "space-1",
      threadId: "thread-1",
      authorUserId: "user-1",
      text: "hello",
    });
    expect(recipients(send)).toEqual(["user-3"]);
  });

  it("sends nothing for a message in a muted chat or a Space of one", async () => {
    const muted = deps({ members: shared, notifyOnFinish: false });
    await notifyMemberMessage(muted.value, {
      spaceId: "space-1",
      threadId: "thread-1",
      authorUserId: "user-1",
      text: "hello",
    });
    const alone = deps();
    await notifyMemberMessage(alone.value, {
      spaceId: "space-1",
      threadId: "thread-1",
      authorUserId: "user-1",
      text: "hello",
    });
    for (const { send, publish } of [muted, alone]) {
      expect(send).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  });
});
