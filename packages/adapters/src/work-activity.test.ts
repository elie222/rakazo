import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { WorkActivityPushProvider } from "./work-activity.js";
import { WORK_ACTIVITY_ROWS, WorkActivities } from "./work-activity.js";

type Run = {
  id: string;
  threadId: string;
  userId: string;
  botId: string;
  status: string;
  trigger: string;
  groupId?: string;
};
type Card = { tokenDigest: string; userId: string; ciphertext: string; lastState: string | null };

const TOKEN = "ab".repeat(32);

/** Just the reads and writes WorkActivities makes, kept in memory. Newer runs come later. */
function fakeDatabase() {
  const runs: Run[] = [];
  const events: Array<{ runId: string; type: string; seq: number; payload: unknown }> = [];
  const cards = new Map<string, Card>();
  const newestFirst = (list: Run[]) => [...list].reverse();
  const prisma = {
    run: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        runs.find((run) => run.id === where.id) ?? null,
      findMany: async ({
        where,
        take,
      }: {
        where: { threadId?: string; userId?: string; status?: { in: string[] } };
        take?: number;
      }) =>
        newestFirst(runs)
          .filter(
            (run) =>
              (!where.threadId || run.threadId === where.threadId) &&
              (!where.userId || run.userId === where.userId) &&
              (!where.status || where.status.in.includes(run.status)),
          )
          .filter((run, index, list) =>
            where.threadId
              ? list.findIndex((other) => other.userId === run.userId) === index
              : true,
          )
          .slice(0, take)
          .map((run) => ({
            ...run,
            spaceId: "space-1",
            bot: { name: run.botId === "bot-1" ? "Planner" : `Bot ${run.botId}` },
            thread: { groupId: run.groupId ?? null },
          })),
    },
    event: {
      findMany: async ({ where, take }: { where: { runId: string; type: string }; take: number }) =>
        events
          .filter((event) => event.runId === where.runId && event.type === where.type)
          .sort((a, b) => b.seq - a.seq)
          .slice(0, take),
    },
    workActivityToken: {
      upsert: async (input: {
        where: { tokenDigest: string };
        create: Omit<Card, "lastState">;
      }) => {
        const current = cards.get(input.where.tokenDigest);
        cards.set(input.where.tokenDigest, current ?? { lastState: null, ...input.create });
      },
      findMany: async ({ where }: { where: { userId: string } }) =>
        [...cards.values()].filter((card) => card.userId === where.userId),
      deleteMany: async ({ where }: { where: { tokenDigest: string } }) => {
        cards.delete(where.tokenDigest);
      },
      updateMany: async (input: { where: { tokenDigest: string }; data: Partial<Card> }) => {
        Object.assign(cards.get(input.where.tokenDigest)!, input.data);
      },
    },
  } as unknown as PrismaClient;
  return { prisma, runs, events, cards };
}

function setup(reply: "sent" | "invalid" | "unavailable" = "sent", windowMs = 20) {
  const db = fakeDatabase();
  const send = vi.fn<WorkActivityPushProvider["send"]>().mockResolvedValue(reply);
  const activities = new WorkActivities(db.prisma, "offline-activity-key", { send }, windowMs);
  const run = (id: string, more: Partial<Run> = {}) =>
    db.runs.push({
      id,
      threadId: `thread-${id}`,
      userId: "user-1",
      botId: `bot-${id}`,
      status: "running",
      trigger: "message",
      ...more,
    });
  run("1", { threadId: "thread-1", botId: "bot-1" });
  return { ...db, send, activities, run };
}

async function registered(reply?: "sent" | "invalid" | "unavailable", windowMs?: number) {
  const context = setup(reply, windowMs);
  expect(await context.activities.register("user-1", TOKEN)).toBe(true);
  await vi.waitFor(() => expect(context.send).toHaveBeenCalledTimes(1));
  return context;
}

describe("live status card of the user's bots at work", () => {
  it("follows only while one of the user's bots is at work", async () => {
    const { activities, cards, runs } = setup();
    expect(await activities.register("user-2", TOKEN)).toBe(false);
    runs[0]!.status = "completed";
    expect(await activities.register("user-1", TOKEN)).toBe(false);
    expect(cards.size).toBe(0);
  });

  it("shows the bot's latest step and sends nothing while it is unchanged", async () => {
    const { activities, cards, events, send } = setup();
    events.push(
      {
        runId: "1",
        type: "thread.progress",
        seq: 1,
        payload: { text: "Reading  the\nbrief", activity: true },
      },
      { runId: "1", type: "thread.progress", seq: 2, payload: { delta: "Here", streaming: true } },
    );
    await activities.register("user-1", TOKEN);
    // The token is stored encrypted.
    expect([...cards.values()][0]!.ciphertext).not.toContain(TOKEN);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // So is the state, which holds chat content.
    await vi.waitFor(() => expect([...cards.values()][0]!.lastState).toBeTruthy());
    expect([...cards.values()][0]!.lastState).not.toContain("Reading");
    expect(send).toHaveBeenCalledWith(TOKEN, {
      state: {
        count: 1,
        waiting: 0,
        rows: [
          {
            status: "working",
            title: "Planner",
            line: "Reading the brief",
            spaceId: "space-1",
            botId: "bot-1",
          },
        ],
      },
      ended: false,
      urgent: false,
      at: expect.any(Number),
    });
    await activities.sync("user-1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sums up every bot at work on one card, questions first", async () => {
    const { activities, run, send } = await registered();
    for (const id of ["2", "3", "4", "5"]) run(id);
    run("6", { status: "waiting_input", groupId: "group-6" });
    // A continuation of a chat's work and background work add no rows.
    run("7", { threadId: "thread-1", botId: "bot-1" });
    run("8", { trigger: "tickets" });
    await activities.sync("user-1");
    const push = send.mock.lastCall![1];
    expect(push).toMatchObject({ ended: false, urgent: true, state: { count: 6, waiting: 1 } });
    expect(push.state.rows).toHaveLength(WORK_ACTIVITY_ROWS);
    expect(push.state.rows[0]).toEqual({
      status: "waiting",
      title: "Bot bot-6",
      line: "",
      spaceId: "space-1",
      groupId: "group-6",
    });
    expect(push.state.rows.slice(1).map((row) => row.title)).toEqual([
      "Planner",
      "Bot bot-5",
      "Bot bot-4",
    ]);
  });

  it("ends the card with its last rows once no bot is at work", async () => {
    const { activities, cards, runs, send } = await registered();
    runs[0]!.status = "completed";
    await activities.sync("user-1");
    expect(send.mock.lastCall![1]).toMatchObject({
      ended: true,
      urgent: true,
      state: { count: 1, rows: [{ title: "Planner" }] },
    });
    expect(cards.size).toBe(0);
  });

  it("tries again a push that did not go through, ending the card only once it does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { activities, cards, runs, send } = await registered("unavailable");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      runs[0]!.status = "completed";
      send.mockResolvedValue("unavailable");
      await activities.sync("user-1");
      expect(send.mock.lastCall![1].ended).toBe(true);
      expect(cards.size).toBe(1);
      send.mockResolvedValue("sent");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(() => expect(cards.size).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a card Apple no longer knows", async () => {
    const { cards } = await registered("invalid");
    expect(cards.size).toBe(0);
  });

  it("updates the owners of a changed thread's work, at most once per window", async () => {
    // Only the clock is fake: the window passes when the test says so, never under load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const window = 10_000;
      const { activities, events, send } = await registered("sent", window);
      await vi.advanceTimersByTimeAsync(window);
      const step = (seq: number) => {
        events.push({
          runId: "1",
          type: "thread.progress",
          seq,
          payload: { text: `Step ${seq}`, activity: true },
        });
        activities.threadChanged("thread-1");
      };
      step(1);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      step(2);
      step(3);
      await vi.advanceTimersByTimeAsync(window / 2);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(window);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      expect(send.mock.calls.map(([, push]) => push.state.rows[0]!.line)).toEqual([
        "",
        "Step 1",
        "Step 3",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
