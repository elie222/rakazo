import type { BackgroundJobHandlers, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { RunJobPublisher, RunWorkerHost, withRunWorker } from "./run-wakeup.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const rows = new Map<string, { status: string; wakeAt: Date | null }>();
  const updateMany = vi.fn(async ({ where, data }) => {
    const row = rows.get(where.id);
    if (!row || !where.status.in.includes(row.status) || (where.wakeAt === null && row.wakeAt))
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const findMany = vi.fn(async () =>
    [...rows]
      .filter(
        ([, row]) => row.status === "queued" && (!row.wakeAt || row.wakeAt.getTime() <= Date.now()),
      )
      .map(([id]) => ({ id, botId: id, bot: { computerId: "computer" } })),
  );
  const leases = vi.fn(async () => [] as { computerId: string; botId: string; runId: string }[]);
  const prisma = {
    run: { updateMany, findMany },
    computerExecutionLease: { findMany: leases },
  } as unknown as PrismaClient;
  const realtime = new InMemoryRealtimeFanout();
  const background = {
    enqueue: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  } as unknown as JobPublisher;
  const publisher = new RunJobPublisher(prisma, realtime, background);
  const host = new RunWorkerHost(prisma, realtime, { intervalMs: 100 });
  return { rows, prisma, realtime, background, publisher, host, findMany, updateMany, leases };
}

describe("durable direct run wakeups", () => {
  it("leaves busy runs untouched, dispatches unrelated chats, and recovers when the lease releases", async () => {
    const f = fixture();
    f.rows.set("busy", { status: "queued", wakeAt: null });
    f.rows.set("free", { status: "queued", wakeAt: null });
    f.leases.mockResolvedValue([{ computerId: "computer", botId: "busy", runId: "holder" }]);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(f.rows.get("free")!.status).toBe("completed"));
      await vi.waitFor(() => expect(f.leases.mock.calls.length).toBeGreaterThan(2));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(f.rows.get("busy")).toEqual({ status: "queued", wakeAt: null });
      expect(f.updateMany).not.toHaveBeenCalled();
      f.leases.mockResolvedValue([]);
      await vi.waitFor(() => expect(f.rows.get("busy")!.status).toBe("completed"));
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await f.host.stop();
    }
  });

  it("allows a run's own held lease and ignores leases on its previous computer", async () => {
    const f = fixture();
    f.rows.set("resume", { status: "queued", wakeAt: null });
    f.rows.set("reassigned", { status: "queued", wakeAt: null });
    f.leases.mockResolvedValue([
      { computerId: "computer", botId: "resume", runId: "resume" },
      { computerId: "old-computer", botId: "reassigned", runId: "holder" },
    ]);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    } finally {
      await f.host.stop();
    }
  });

  it("starts chat without invoking Graphile, deduplicates wakeups, and drains long executions", async () => {
    const f = fixture();
    f.rows.set("chat", { status: "queued", wakeAt: null });
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async ({ runId }, execution) => {
      expect(currentDbContext()?.kind).toBe("system");
      f.rows.get(runId)!.status = "running";
      execution.onRunStarted();
      await done;
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await f.publisher.enqueue(runContinueJob("chat"));
      await f.publisher.enqueue(runContinueJob("chat"));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(f.background.enqueue).not.toHaveBeenCalled();
      let stopped = false;
      const stopping = f.host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
    } finally {
      release();
      await f.host.stop();
    }
  });

  it("repairs a missed notification and preserves a future retry through reconciliation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rows.set("delayed", { status: "queued", wakeAt: null });
    vi.spyOn(f.realtime, "publish").mockRejectedValue(
      new Error("fixture notification unavailable"),
    );
    const due = new Date(Date.now() + 1_000);
    await f.publisher.enqueue({ ...runContinueJob("delayed"), availableAt: due });
    await f.publisher.enqueue({ ...runContinueJob("delayed"), keepExisting: true });
    expect(f.rows.get("delayed")!.wakeAt).toEqual(due);
    const handler = vi.fn(async ({ runId }) => {
      f.rows.get(runId)!.status = "completed";
    });
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(900);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await f.host.stop();
    }
  });

  it("leaves schedules and maintenance with the background scheduler", async () => {
    const f = fixture();
    const job = { name: "routine.retry", payload: { runId: "routine" } } as const;
    await f.publisher.enqueue(job);
    expect(f.background.enqueue).toHaveBeenCalledExactlyOnceWith(job);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("does not serialize unrelated claims behind one slow startup", async () => {
    const f = fixture();
    f.rows.set("slow", { status: "queued", wakeAt: null });
    f.rows.set("fast", { status: "queued", wakeAt: null });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    const handler = async ({ runId }: { runId: string }) => {
      if (runId === "slow") await pending;
      entered.push(runId);
      f.rows.get(runId)!.status = "completed";
    };
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.waitFor(() => expect(entered).toEqual(["fast"]));
      release();
      await vi.waitFor(() => expect(entered).toEqual(["fast", "slow"]));
    } finally {
      release();
      await f.host.stop();
    }
  });

  it("can restart after notification subscription fails", async () => {
    const f = fixture();
    vi.spyOn(f.realtime, "subscribe").mockRejectedValueOnce(new Error("fixture subscribe failure"));
    const target = { "run.continue": vi.fn() } as unknown as BackgroundJobHandlers;
    await expect(f.host.start(target)).rejects.toThrow("fixture subscribe failure");
    try {
      await f.host.start(target);
      await vi.waitFor(() => expect(f.findMany).toHaveBeenCalled());
    } finally {
      await f.host.stop();
    }
  });

  it("keeps direct dispatch running while background startup waits for database capacity", async () => {
    const runs = { start: vi.fn(), stop: vi.fn() } as unknown as RunWorkerHost;
    const background = {
      start: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("fixture scheduler unavailable"), { code: "53300" }),
        ),
      stop: vi.fn(),
    };
    await expect(
      withRunWorker(runs, background).start({} as BackgroundJobHandlers),
    ).rejects.toThrow("fixture scheduler unavailable");
    expect(runs.start).toHaveBeenCalledOnce();
    expect(runs.stop).not.toHaveBeenCalled();
  });
  it("drains direct runs before propagating a fatal scheduler startup failure", async () => {
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = { start: vi.fn(), stop: vi.fn(() => drain) } as unknown as RunWorkerHost;
    const background = {
      start: vi.fn().mockRejectedValue(new Error("fatal fixture startup")),
      stop: vi.fn(),
    };
    let rejected = false;
    const starting = withRunWorker(runs, background)
      .start({} as BackgroundJobHandlers)
      .catch(() => {
        rejected = true;
      });
    await vi.waitFor(() => expect(runs.stop).toHaveBeenCalledOnce());
    expect(rejected).toBe(false);
    release();
    await starting;
    expect(rejected).toBe(true);
  });

  it("waits for an in-flight scheduler start before finishing shutdown", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = { start: vi.fn(), stop: vi.fn() } as unknown as RunWorkerHost;
    const background = { start: vi.fn(() => pending), stop: vi.fn() };
    const host = withRunWorker(runs, background);
    const starting = host.start({} as BackgroundJobHandlers);
    await vi.waitFor(() => expect(background.start).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(runs.stop).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    release();
    await starting;
    await stopping;
    expect(stopped).toBe(true);
    expect(background.stop).toHaveBeenCalledTimes(2);
  });
});
