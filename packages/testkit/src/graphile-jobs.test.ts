import {
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  PostgresRealtimeFanout,
} from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeGraphile = hasDb ? describe : describe.skip;

describeGraphile("Graphile jobs and Postgres fanout", () => {
  let pool: ReturnType<typeof createDb>["pool"];
  let prisma: ReturnType<typeof createDb>["prisma"];

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    pool = db.pool;
    prisma = db.prisma;
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("delivers, replaces, delays, cancels, and shuts down", async () => {
    const connectionString = process.env.DATABASE_URL!;
    const publisher = new GraphileJobPublisher(connectionString);
    const worker = new GraphileJobWorkerHost(connectionString, {
      concurrency: 1,
      pollInterval: 50,
      noHandleSignals: true,
    });
    const received: Array<{ name: string; payload: unknown }> = [];
    const continueCalls: string[] = [];
    let continueResolve: (() => void) | undefined;
    const firstContinue = new Promise<void>((resolve) => {
      continueResolve = resolve;
    });

    await worker.start({
      "run.continue": async (payload) => {
        continueCalls.push(payload.runId);
        received.push({ name: "run.continue", payload });
        continueResolve?.();
      },
      "routine.wakeup": async (payload) => {
        received.push({ name: "routine.wakeup", payload });
      },
      "computer.sleep": async (payload) => {
        received.push({ name: "computer.sleep", payload });
      },
    });

    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "run-deliver" },
        replaceKey: "run:deliver",
      });
      await firstContinue;
      expect(continueCalls).toEqual(["run-deliver"]);

      await publisher.enqueue({
        name: "computer.sleep",
        payload: { botId: "old" },
        availableAt: new Date(Date.now() + 2_000),
        replaceKey: "computer.sleep:replace",
      });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { botId: "new" },
        availableAt: new Date(Date.now() + 150),
        replaceKey: "computer.sleep:replace",
      });
      await waitUntil(() => received.some((row) => row.name === "computer.sleep"), 3_000);
      expect(
        received.filter((row) => row.name === "computer.sleep").map((row) => row.payload),
      ).toEqual([{ botId: "new" }]);

      await publisher.enqueue({
        name: "routine.wakeup",
        payload: { routineId: "routine-1", scheduledFor: new Date().toISOString() },
        availableAt: new Date(Date.now() + 2_000),
        replaceKey: "routine:cancel",
      });
      await publisher.cancel("routine:cancel");
      await delay(400);
      expect(received.some((row) => row.name === "routine.wakeup")).toBe(false);
    } finally {
      await worker.stop();
      const afterStop = received.length;
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "run-after-stop" },
        replaceKey: "run:after-stop",
      });
      await delay(300);
      expect(received).toHaveLength(afterStop);
      await publisher.close();
    }
  }, 20_000);

  it("delivers LISTEN/NOTIFY to a matching subscriber", async () => {
    const fanout = new PostgresRealtimeFanout({
      connectionString: process.env.DATABASE_URL!,
      publisher: pool,
    });
    const payloads: string[] = [];
    const unsubscribe = await fanout.subscribe("thread:graphile", (payload) => {
      payloads.push(payload);
    });
    try {
      await waitUntil(() => payloads.includes(""), 2_000);
      await fanout.publish("thread:graphile", "wake-1");
      await waitUntil(() => payloads.includes("wake-1"), 2_000);
    } finally {
      await unsubscribe();
      await fanout.close();
    }
  }, 10_000);
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting: ${ms}ms`);
}
