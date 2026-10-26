import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-a",
  userId: "user-a",
  email: "actor@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const routine = (botId: string, id: string) => ({
  id,
  botId,
  userId: actor.userId,
  name: id,
  prompt: "Test",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: false,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
function harness() {
  const findBots = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    [...where.id.in]
      .reverse()
      .filter((id) => id !== "excluded")
      .map((id) => ({ id })),
  );
  let active = 0;
  let peak = 0;
  const findRoutines = vi.fn(async ({ where }: { where: { botId: string } }) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (where.botId === "failed") throw new Error("offline");
    return [routine(where.botId, `${where.botId}-2`), routine(where.botId, `${where.botId}-1`)];
  });
  const findBot = vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  const deps = {
    prisma: {
      bot: { findMany: findBots, findFirst: findBot },
      routine: { findMany: findRoutines },
    } as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-routine-mentions-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function request(
    botIds: string[],
    requestActor: Actor | null = actor,
    signal?: AbortSignal,
  ) {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/routines/listForMentions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botIds } }),
      }),
      { prefix: "/rpc", context: { actor: requestActor, signal } },
    );
    return response!;
  }
  async function legacyRequest(botId: string) {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/routines/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response!;
  }
  return { findBots, findBot, findRoutines, request, legacyRequest, peak: () => peak };
}

describe("routine mention batch endpoint", () => {
  it("uses one ownership read for 100 bots, retaining per-bot order and four-read concurrency", async () => {
    const h = harness();
    const ids = Array.from({ length: 100 }, (_, index) => `bot-${index}`);
    const response = await h.request(ids);
    expect(response.status).toBe(200);
    const body = (await response.json()).json;
    expect(body).toHaveLength(100);
    expect(
      body
        .find((list: { botId: string }) => list.botId === "bot-0")
        .routines.map((row: { id: string }) => row.id),
    ).toEqual(["bot-0-2", "bot-0-1"]);
    expect(h.findBots).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ids }, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    expect(h.findRoutines).toHaveBeenCalledTimes(100);
    expect(
      h.findRoutines.mock.calls.every(
        ([input]) => (input.where as { spaceId?: string }).spaceId === actor.spaceId,
      ),
    ).toBe(true);
    expect(h.peak()).toBe(4);
  });

  it("matches the current per-bot HTTP responses with one ownership query", async () => {
    const h = harness();
    const ids = Array.from({ length: 100 }, (_, index) => `bot-${index}`);
    const before = [];
    for (const botId of ids) {
      const response = await h.legacyRequest(botId);
      expect(response.status).toBe(200);
      before.push({ botId, routines: (await response.json()).json });
    }
    expect(h.findBot).toHaveBeenCalledTimes(100);
    expect(h.findRoutines).toHaveBeenCalledTimes(100);
    h.findRoutines.mockClear();
    const response = await h.request(ids);
    const after = (await response.json()).json;
    expect(ids.map((id) => after.find((list: { botId: string }) => list.botId === id))).toEqual(
      before,
    );
    expect(h.findBots).toHaveBeenCalledTimes(1);
    expect(h.findBot).toHaveBeenCalledTimes(100);
    expect(h.findRoutines).toHaveBeenCalledTimes(100);
  });

  it("omits failed or excluded parents without reading excluded routines", async () => {
    const h = harness();
    const response = await h.request(["bot-1", "excluded", "failed"]);
    expect(response.status).toBe(200);
    expect((await response.json()).json.map((list: { botId: string }) => list.botId)).toEqual([
      "bot-1",
    ]);
    expect(h.findRoutines.mock.calls.map(([input]) => input.where.botId).sort()).toEqual([
      "bot-1",
      "failed",
    ]);
  });

  it("stops launching queued routine reads when the HTTP request is aborted", async () => {
    const h = harness();
    const pending: Array<() => void> = [];
    h.findRoutines.mockImplementation(async ({ where }) => {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      return [routine(where.botId, where.botId)];
    });
    const abort = new AbortController();
    const response = h.request(
      Array.from({ length: 100 }, (_, index) => `bot-${index}`),
      actor,
      abort.signal,
    );
    await vi.waitFor(() => expect(h.findRoutines).toHaveBeenCalledTimes(4));
    abort.abort();
    for (const resolve of pending) resolve();
    await response;
    expect(h.findRoutines).toHaveBeenCalledTimes(4);
  });

  it("rejects unauthenticated or oversized batches before reading data", async () => {
    const h = harness();
    expect((await h.request(["bot-1"], null)).status).toBe(401);
    expect(
      (await h.request(Array.from({ length: 101 }, (_, index) => `bot-${index}`))).status,
    ).toBe(400);
    expect(h.findBots).not.toHaveBeenCalled();
  });
});
