import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  postRoutineNotice: vi.fn(async (_deps: unknown, _input: Record<string, unknown>) => true),
}));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  ...adapters,
}));

import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";

const actor = { userId: "user-1", spaceId: "space-1" };
const routine = {
  id: "routine-1",
  botId: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  threadId: null,
  name: "Morning joke",
  prompt: "SECRET PROMPT",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  lastRunAt: null,
  nextRunAt: new Date("2030-01-01T09:00:00Z"),
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

function client(saved: Record<string, unknown> = routine) {
  const write = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...saved,
    ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  }));
  return createRouterClient(
    createRouter({
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot-1",
            thread: { id: "bot-thread" },
            computer: null,
          })),
        },
        routine: {
          findFirst: vi.fn(async () => saved),
          create: write,
          update: write,
          delete: vi.fn(async () => saved),
          count: vi.fn(async () => 0),
        },
        spaceMember: {
          findMany: vi.fn(async () => [
            { userId: "user-1", member: { user: { name: "Riley", email: "riley@example.test" } } },
          ]),
        },
        userModelPreference: { findMany: vi.fn(async () => []) },
      },
      env: { sandboxProvider: "fake" },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as RouterDeps),
    { context: { actor } as never },
  );
}

const lastNotice = () => adapters.postRoutineNotice.mock.calls.at(-1)![1];

beforeEach(() => vi.clearAllMocks());

describe("routine rows from the routines API", () => {
  it("create leaves a created row in the bot's chat, with the name only", async () => {
    await client().routines.create({
      botId: "bot-1",
      name: "Morning joke",
      prompt: "SECRET PROMPT",
      crons: ["0 9 * * *"],
    });
    expect(lastNotice()).toEqual({
      spaceId: "space-1",
      threadId: "bot-thread",
      botId: "bot-1",
      change: "created",
      name: "Morning joke",
      routine: { webhookEnabled: false, active: expect.any(Boolean) },
    });
    expect(JSON.stringify(adapters.postRoutineNotice.mock.calls)).not.toContain("SECRET PROMPT");
  });

  it("passes the saved routine's state, which decides whether its row offers the key", async () => {
    await client({ ...routine, webhookEnabled: true }).routines.update({
      routineId: "routine-1",
      name: "Deploy hook",
    });
    expect(lastNotice()).toMatchObject({
      change: "updated",
      routine: { webhookEnabled: true, active: true },
    });
    await client({ ...routine, webhookEnabled: true, active: false }).routines.update({
      routineId: "routine-1",
      name: "Deploy hook",
    });
    expect(lastNotice()).toMatchObject({ routine: { webhookEnabled: true, active: false } });
  });

  it("a routine saved in a group posts to that group's chat", async () => {
    await client({ ...routine, threadId: "group-thread" }).routines.update({
      routineId: "routine-1",
      name: "Renamed",
    });
    expect(lastNotice()).toMatchObject({ threadId: "group-thread", change: "updated" });
  });

  it("update reads a switch as disabled or enabled, and an edit as updated", async () => {
    await client().routines.update({ routineId: "routine-1", active: false });
    expect(lastNotice()).toMatchObject({ change: "disabled", name: "Morning joke" });
    await client({ ...routine, active: false }).routines.update({
      routineId: "routine-1",
      active: true,
    });
    expect(lastNotice()).toMatchObject({ change: "enabled" });
    await client().routines.update({ routineId: "routine-1", prompt: "SECRET PROMPT 2" });
    expect(lastNotice()).toMatchObject({ change: "updated" });
    expect(JSON.stringify(adapters.postRoutineNotice.mock.calls)).not.toContain("SECRET PROMPT");
  });

  it("a save that changes nothing leaves no row", async () => {
    await client().routines.update({ routineId: "routine-1", name: "Morning joke", active: true });
    expect(adapters.postRoutineNotice).not.toHaveBeenCalled();
  });

  it("remove leaves a deleted row with the name only", async () => {
    await expect(client().routines.remove({ routineId: "routine-1" })).resolves.toEqual({
      ok: true,
    });
    expect(lastNotice()).toMatchObject({
      change: "deleted",
      name: "Morning joke",
      botId: "bot-1",
      threadId: null,
    });
  });
});
