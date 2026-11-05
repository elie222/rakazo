// R5 实测审核：捕获管线（memory-capture.ts）的并发、确定性、毒丸、批边界与 ACK 后失败。
// 全部离线、确定性；假 prisma 与假 advisory lock 共享内存状态。
import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  TurnMemoryCapture,
  TurnMemoryCaptureResult,
  TurnMemoryLifecycle,
} from "@rakazo/adapter-kit";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { ContentKeyRing, ciphertextKeyId, LocalKeyProvider, Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";
import { memmyCaptureBody } from "./memmy-turn-memory.js";
import type {
  CaptureTurnRunRow,
  MemoryCaptureLock,
  MemoryCapturePrisma,
} from "./memory-capture.js";
import {
  buildTurnMemoryCapture,
  captureFinishedTurn,
  MEMORY_CAPTURE_BATCH_SIZE,
} from "./memory-capture.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

function runRow(overrides: Partial<CaptureTurnRunRow> = {}): CaptureTurnRunRow {
  return {
    id: "run-123",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    botId: "bot-1",
    status: "completed",
    startedAt: new Date("2026-11-04T10:00:00.000Z"),
    completedAt: new Date("2026-11-04T10:00:05.000Z"),
    createdAt: new Date("2026-11-04T09:59:59.000Z"),
    sourceMessageId: "msg-user-1",
    memoryCaptureDueAt: new Date("2026-11-04T10:00:05.000Z"),
    memoryCapturedAt: null,
    memoryRecallIds: ["mem-a", "mem-b"],
    memoryCaptureScope: "isolated",
    memoryCapturePayload: null,
    ...overrides,
  };
}

type CaptureFn = (
  capture: TurnMemoryCapture,
  context: AdapterContext,
) => Promise<TurnMemoryCaptureResult>;

function lifecycleOf(impl?: CaptureFn) {
  const captureTurn = vi.fn<CaptureFn>(impl ?? (async () => ({ status: "stored" })));
  const lifecycle: TurnMemoryLifecycle = { beforeTurn: vi.fn(async () => null), captureTurn };
  return { lifecycle, captureTurn };
}

function resolverOf(lifecycle: TurnMemoryLifecycle): MemoryProviderResolver {
  return {
    resolveTurnMemory: vi.fn(async () => ({
      kind: "configured" as const,
      lifecycle,
      defaultScope: "isolated" as const,
    })),
    resolve: vi.fn(async () => null),
  };
}

/** 共享内存的假 prisma：所有并发 handler 读写同一个 rows Map。 */
function fakePrisma(runs: CaptureTurnRunRow[]) {
  const rows = new Map(runs.map((run) => [run.id, structuredClone(run)]));
  const pending = (run: CaptureTurnRunRow, where: Prisma.RunWhereInput) =>
    run.status === where.status &&
    run.threadId === where.threadId &&
    run.botId === where.botId &&
    run.memoryCaptureDueAt !== null &&
    run.memoryCapturedAt === null &&
    (where.memoryCaptureScope !== undefined
      ? run.memoryCaptureScope === where.memoryCaptureScope
      : run.memoryCaptureScope === "isolated" || run.memoryCaptureScope === null);
  const prisma: MemoryCapturePrisma = {
    run: {
      findUnique: vi.fn(async ({ where }) => structuredClone(rows.get(where.id) ?? null)),
      findMany: vi.fn(async ({ where, take }) =>
        [...rows.values()]
          .filter((run) => pending(run, where))
          .sort(
            (a, b) =>
              a.memoryCaptureDueAt!.getTime() - b.memoryCaptureDueAt!.getTime() ||
              a.id.localeCompare(b.id),
          )
          .slice(0, take)
          .map(({ id }) => ({ id })),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = rows.get(where.id);
        if (!row || row.memoryCapturedAt !== null) return { count: 0 };
        if (data.memoryCaptureAttempts) {
          row.memoryCaptureAttempts =
            (row.memoryCaptureAttempts ?? 0) + data.memoryCaptureAttempts.increment;
          return { count: 1 };
        }
        if (row.memoryCapturePayload !== null) return { count: 0 };
        row.memoryCapturePayload = structuredClone(data.memoryCapturePayload);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = rows.get(where.id)!;
        row.memoryCapturedAt = data.memoryCapturedAt;
        row.memoryCapturePayload = null;
        return structuredClone(row);
      }),
    },
    message: {
      findFirst: vi.fn(async () => ({
        seq: 4,
        blocks: [{ kind: "text", text: "How do we deploy Rakazo?" }],
      })),
      findMany: vi.fn(async () => [
        { blocks: [{ kind: "text", text: "Use the release pipeline." }], clientNonce: null },
      ]),
    },
  };
  return { prisma, rows };
}

/** 进程间 pg_try_advisory_lock 的语义：同 key 第二个调用者立即 acquired:false。 */
function sharedAdvisoryLock(): MemoryCaptureLock {
  const held = new Set<string>();
  return async (key, run) => {
    if (held.has(key)) return { acquired: false };
    held.add(key);
    try {
      return { acquired: true, value: await run() };
    } finally {
      held.delete(key);
    }
  };
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function keyRing() {
  const records: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) =>
      records.filter((row) => row.spaceId === spaceId).sort((a, b) => a.version - b.version),
    byId: async (id) => records.find((row) => row.id === id),
    insert: async (record) => {
      records.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => records.slice(0, 1),
  };
  const master = { id: "fixture-master-1", key: randomBytes(32) };
  return { store, master, records };
}

// ---------------------------------------------------------------------------
describe("R5 #1 并发：同一 run 被两个 handler 同时处理", () => {
  it("有共享 advisory lock 时，两个并发 handler 只发送一次", async () => {
    const hold = gate();
    const { lifecycle, captureTurn } = lifecycleOf(async () => {
      await hold.opened;
      return { status: "stored" };
    });
    const { prisma, rows } = fakePrisma([runRow()]);
    const lock = sharedAdvisoryLock();
    const deps = { prisma, memoryProviders: resolverOf(lifecycle), lock };

    const first = captureFinishedTurn(deps, "run-123");
    const second = captureFinishedTurn(deps, "run-123");
    await new Promise((resolve) => setTimeout(resolve, 0));
    hold.open();
    await Promise.all([first, second]);

    expect(captureTurn).toHaveBeenCalledTimes(1);
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it("没有 lock 时并发会发送两次，但 CAS 保证两次载荷字节相同", async () => {
    const hold = gate();
    const { lifecycle, captureTurn } = lifecycleOf(async () => {
      await hold.opened;
      return { status: "existing" };
    });
    const { prisma } = fakePrisma([runRow()]);
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };

    const both = Promise.all([
      captureFinishedTurn(deps, "run-123"),
      captureFinishedTurn(deps, "run-123"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hold.open();
    await both;

    expect(captureTurn).toHaveBeenCalledTimes(2);
    // Two freezes; the per-attempt counter writes are a separate concern.
    expect(
      vi
        .mocked(prisma.run.updateMany)
        .mock.calls.filter(([args]: any) => args.data.memoryCapturePayload !== undefined).length,
    ).toBe(2);
    const [a, b] = captureTurn.mock.calls.map(([capture]) => JSON.stringify(capture));
    expect(a).toBe(b);
  });

  it("丢唤醒的兜底：已有 100 条更老的未捕获轮次时，reconciler 不会重新入队这条新轮次", async () => {
    const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const now = Date.now();
    // 100 条被别的会话头部阻塞（或 provider 故障）而一直未捕获的旧轮次 + 1 条丢了唤醒的新轮次。
    const uncaptured = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `stuck-${String(i).padStart(3, "0")}`,
        threadId: "stuck-thread",
        due: now - 3_600_000 + i,
      })),
      { id: "lost-wakeup", threadId: "healthy-thread", due: now - 1_000 },
    ];
    const runFindMany = vi.fn(
      async (
        args: { where?: Record<string, unknown>; take?: number; distinct?: string[] } = {},
      ) => {
        if (
          args.where &&
          "memoryCaptureDueAt" in args.where &&
          args.where.memoryCapturedAt === null
        ) {
          const sorted = [...uncaptured].sort((a, b) => a.due - b.due);
          // Prisma applies distinct before take; the reconciler asks one row per thread.
          const rows = args.distinct?.includes("threadId")
            ? sorted.filter(
                (row, index) =>
                  sorted.findIndex((other) => other.threadId === row.threadId) === index,
              )
            : sorted;
          return rows.slice(0, args.take).map(({ id }) => ({ id }));
        }
        return [];
      },
    );
    const prisma = {
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 0 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;

    // 连续 3 个 reconcile 周期（各 30s）
    const reconciler = createJobReconciler({ prisma, jobs });
    for (let pass = 0; pass < 3; pass += 1) await reconciler.reconcileOnce();

    const captureJobs = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.name === "memory.capture")
      .map((job) => (job.payload as { runId: string }).runId);
    expect(captureJobs).toContain("lost-wakeup");
  });

  it("持锁者已查完待办后才到期的新一轮，其 job 拿不到锁返回成功，但该轮未被捕获（丢唤醒）", async () => {
    const hold = gate();
    const reached = gate();
    const { lifecycle, captureTurn } = lifecycleOf(async (capture) => {
      if (capture.runId === "run-a") {
        reached.open();
        await hold.opened;
      }
      return { status: "stored" };
    });
    const { prisma, rows } = fakePrisma([runRow({ id: "run-a" })]);
    const lock = sharedAdvisoryLock();
    const deps = { prisma, memoryProviders: resolverOf(lifecycle), lock };

    // job A 持锁、已执行 findMany（只看到 run-a），正在发送。
    const jobA = captureFinishedTurn(deps, "run-a");
    await reached.opened;
    // 这时同一会话下一轮完成并入队 job B。
    rows.set(
      "run-b",
      runRow({ id: "run-b", memoryCaptureDueAt: new Date("2026-11-04T10:05:00.000Z") }),
    );
    const jobB = captureFinishedTurn(deps, "run-b");
    // job B 必须以“成功”结束——队列不会重试它。
    await expect(jobB).resolves.toBeUndefined();
    hold.open();
    await jobA;

    expect(captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual(["run-a", "run-b"]);
    expect(rows.get("run-b")?.memoryCapturedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
describe("R5 #2 确定性：buildTurnMemoryCapture 与冻结重放", () => {
  const messages = {
    sourceMessage: { seq: 7, blocks: [{ kind: "text", text: "记住：部署走 release 流水线" }] },
    botMessages: [
      {
        blocks: [
          { kind: "text", text: "好的，已记住。" },
          { kind: "steps", steps: [{ label: "memory.save", note: "n" }] },
          { kind: "subagent", name: "planner", task: "t", result: "r" },
        ],
        clientNonce: null,
      },
    ],
  };

  it("同一行数据构造两次，JSON 字节完全相同（隔开 5 秒真实时钟）", () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T00:00:00Z") });
    try {
      const a = JSON.stringify(buildTurnMemoryCapture(runRow(), messages, "isolated", ["x"]));
      vi.advanceTimersByTime(5_000);
      const b = JSON.stringify(buildTurnMemoryCapture(runRow(), messages, "isolated", ["x"]));
      expect(a).toBe(b);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completedAt 为空但 createdAt 存在时仍确定", () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T00:00:00Z") });
    try {
      const row = runRow({ completedAt: null, startedAt: null });
      const a = JSON.stringify(buildTurnMemoryCapture(row, messages));
      vi.advanceTimersByTime(5_000);
      const b = JSON.stringify(buildTurnMemoryCapture(row, messages));
      expect(a).toBe(b);
    } finally {
      vi.useRealTimers();
    }
  });

  it("首次发送与 JSONB 键序重排后的重放，生成的 source-turn 请求体字节相同", async () => {
    const first = vi.fn<CaptureFn>(async () => ({ status: "retryable", reason: "ack_lost" }));
    const { prisma, rows } = fakePrisma([runRow()]);
    await expect(
      captureFinishedTurn(
        { prisma, memoryProviders: resolverOf({ beforeTurn: vi.fn(), captureTurn: first }) },
        "run-123",
      ),
    ).rejects.toThrow("retryable");
    // 模拟 Postgres jsonb 的键重排：按 key 长度再字典序。
    const frozen = rows.get("run-123")!.memoryCapturePayload as Record<string, unknown>;
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
                .map(([k, v]) => [k, reorder(v)]),
            )
          : value;
    rows.get("run-123")!.memoryCapturePayload = reorder(frozen);
    const second = vi.fn<CaptureFn>(async () => ({ status: "existing" }));
    await captureFinishedTurn(
      { prisma, memoryProviders: resolverOf({ beforeTurn: vi.fn(), captureTurn: second }) },
      "run-123",
    );
    const target = { ownerId: "owner-1", spaceId: "space-1" };
    expect(JSON.stringify(memmyCaptureBody(second.mock.calls[0]![0], target, "req"))).toBe(
      JSON.stringify(memmyCaptureBody(first.mock.calls[0]![0], target, "req")),
    );
  });
});

// ---------------------------------------------------------------------------
describe("R5 #3 毒丸：最老一轮永久失败", () => {
  it.each([
    ["provider 抛 TypeError", () => Promise.reject(new TypeError("bad state"))],
    [
      "provider 返回 terminal",
      async () => ({ status: "terminal" as const, reason: "rejected_422" }),
    ],
  ])("%s 后退休最老一轮，后一轮继续", async (_label, oldest) => {
    const { lifecycle, captureTurn } = lifecycleOf(async (capture) =>
      capture.runId === "run-1" ? oldest() : { status: "stored" },
    );
    const { prisma, rows } = fakePrisma([runRow({ id: "run-1" }), runRow({ id: "run-2" })]);
    await captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-2");
    expect(captureTurn.mock.calls.map(([c]) => c.runId)).toEqual(["run-1", "run-2"]);
    expect(rows.get("run-1")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-2")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it("冻结快照损坏（zod 失败）时退休，后一轮继续", async () => {
    const { lifecycle, captureTurn } = lifecycleOf();
    const { prisma, rows } = fakePrisma([
      runRow({ id: "run-1", memoryCapturePayload: { query: 1 } }),
      runRow({ id: "run-2" }),
    ]);
    await captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-2");
    expect(captureTurn.mock.calls.map(([c]) => c.runId)).toEqual(["run-2"]);
    expect(rows.get("run-1")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it("最老一轮对某个具体载荷永远 retryable（如该轮固定触发 5xx）时，后一轮在 30 次作业尝试内仍能被捕获", async () => {
    const { lifecycle, captureTurn } = lifecycleOf(async (capture) =>
      capture.runId === "run-1"
        ? { status: "retryable", reason: "http_500" }
        : { status: "stored" },
    );
    const { prisma, rows } = fakePrisma([
      runRow({ id: "run-1", memoryCaptureDueAt: new Date("2026-09-01T00:00:00Z") }),
      runRow({ id: "run-2" }),
    ]);
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };
    // 6 次 maxAttempts × 5 轮 reconciler 重新入队
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await captureFinishedTurn(deps, "run-2").catch(() => undefined);
    }
    // 现状：30 次尝试里只发送过 run-1，run-2 一次都没发出。
    expect(captureTurn.mock.calls.map(([c]) => c.runId)).toContain("run-2");
    expect(rows.get("run-2")?.memoryCapturedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
describe("R5 #4 排空循环边界（BATCH = 25）", () => {
  it.each([
    [24, 2],
    [25, 2],
    [26, 3],
    [50, 3],
    [51, 4],
  ])("恰好 %i 条待办：全部捕获、按序、findMany 调用 %i 次、不死循环", async (count, queries) => {
    expect(MEMORY_CAPTURE_BATCH_SIZE).toBe(25);
    const runs = Array.from({ length: count }, (_, i) =>
      runRow({ id: `run-${String(i).padStart(3, "0")}` }),
    );
    const { lifecycle, captureTurn } = lifecycleOf();
    const { prisma, rows } = fakePrisma([...runs].reverse());
    await captureFinishedTurn(
      { prisma, memoryProviders: resolverOf(lifecycle) },
      runs[count - 1]!.id,
    );
    expect(captureTurn.mock.calls.map(([c]) => c.runId)).toEqual(runs.map((r) => r.id));
    expect(prisma.run.findMany).toHaveBeenCalledTimes(queries);
    expect([...rows.values()].every((r) => r.memoryCapturedAt instanceof Date)).toBe(true);
  });

  it("恰好 25 条且第 25 条 retryable：抛出、不再查询下一批、不死循环", async () => {
    const runs = Array.from({ length: 25 }, (_, i) =>
      runRow({ id: `run-${String(i).padStart(3, "0")}` }),
    );
    const { lifecycle } = lifecycleOf(async (c) =>
      c.runId === "run-024" ? { status: "retryable", reason: "x" } : { status: "stored" },
    );
    const { prisma } = fakePrisma(runs);
    await expect(
      captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-000"),
    ).rejects.toThrow("retryable: run-024");
    expect(prisma.run.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("R5 #5 ACK 后：markCaptureDone 与快照", () => {
  it("lifecycle stored 后 markCaptureDone 写库失败：快照保留，重试重放同一载荷并完成", async () => {
    const { lifecycle, captureTurn } = lifecycleOf(async () => ({ status: "existing" }));
    const { prisma, rows } = fakePrisma([runRow()]);
    const realUpdate = vi.mocked(prisma.run.update).getMockImplementation()!;
    // The first update of a turn is the attempt counter; the acknowledgement is the one
    // whose failure this test is about, so fail it once and let the retry through.
    let acknowledgementFailed = false;
    vi.mocked(prisma.run.update).mockImplementation(async (args: any) => {
      if ("memoryCapturedAt" in args.data && !acknowledgementFailed) {
        acknowledgementFailed = true;
        throw Object.assign(new Error("db gone"), { code: "P1001" });
      }
      return realUpdate(args);
    });
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };
    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow("db gone");
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-123")?.memoryCapturePayload).not.toBeNull();
    expect(realUpdate).toBeDefined();

    await captureFinishedTurn(deps, "run-123");
    expect(captureTurn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(captureTurn.mock.calls[1]![0])).toBe(
      JSON.stringify(captureTurn.mock.calls[0]![0]),
    );
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it("lifecycle 抛可重试错误（ECONNRESET）：快照保留，重试拿到同一载荷", async () => {
    let calls = 0;
    const { lifecycle, captureTurn } = lifecycleOf(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return { status: "stored" };
    });
    const { prisma, rows } = fakePrisma([runRow()]);
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };
    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow();
    expect(rows.get("run-123")?.memoryCapturePayload).not.toBeNull();
    // 消息被编辑也不影响重放
    vi.mocked(prisma.message.findFirst!).mockResolvedValue({
      seq: 4,
      blocks: [{ kind: "text", text: "edited" }],
    });
    await captureFinishedTurn(deps, "run-123");
    expect(captureTurn.mock.calls[1]![0]).toEqual(captureTurn.mock.calls[0]![0]);
    expect(captureTurn.mock.calls[1]![0].query).toBe("How do we deploy Rakazo?");
  });

  it("加密快照重放时密钥库读取遇到未分类的瞬时 DB 错误：不应永久退休该轮", async () => {
    const keys = keyRing();
    let ring = new ContentKeyRing(new LocalKeyProvider([keys.master]), keys.store);
    let call = 0;
    const { lifecycle, captureTurn } = lifecycleOf(async () => {
      call += 1;
      return call === 1 ? { status: "retryable", reason: "ack_lost" } : { status: "stored" };
    });
    const { prisma, rows } = fakePrisma([runRow()]);
    Object.assign(prisma, { $contentEncryption: () => ({ ring }) });
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };
    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow("retryable");
    expect(ciphertextKeyId(rows.get("run-123")!.memoryCapturePayload)).toBeTruthy();

    // 新 worker（无密钥缓存），连接池瞬断：node-postgres 这类错误没有 code。
    ring = new ContentKeyRing(new LocalKeyProvider([keys.master]), {
      ...keys.store,
      byId: async () => {
        throw new Error("Connection terminated unexpectedly");
      },
    });
    await captureFinishedTurn(deps, "run-123").catch(() => undefined);

    // 同一个错误若发生在 run.findMany/update 上会被原样抛出、保留待办；这里却被退休。
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-123")?.memoryCapturePayload).not.toBeNull();
    expect(captureTurn).toHaveBeenCalledTimes(1);
  });

  it("对照：密钥库读取遇到带 P1001 code 的错误时保留待办", async () => {
    const keys = keyRing();
    let ring = new ContentKeyRing(new LocalKeyProvider([keys.master]), keys.store);
    const { lifecycle } = lifecycleOf(async () => ({ status: "retryable", reason: "ack_lost" }));
    const { prisma, rows } = fakePrisma([runRow()]);
    Object.assign(prisma, { $contentEncryption: () => ({ ring }) });
    const deps = { prisma, memoryProviders: resolverOf(lifecycle) };
    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow("retryable");
    ring = new ContentKeyRing(new LocalKeyProvider([keys.master]), {
      ...keys.store,
      byId: async () => {
        throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
      },
    });
    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-123")?.memoryCapturePayload).not.toBeNull();
  });

  it("对照：同样的未分类错误发生在 run.findMany 上时，抛出并保留待办", async () => {
    const { lifecycle } = lifecycleOf();
    const { prisma, rows } = fakePrisma([runRow()]);
    vi.mocked(prisma.run.findMany).mockRejectedValueOnce(
      new Error("Connection terminated unexpectedly"),
    );
    await expect(
      captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-123"),
    ).rejects.toThrow("Connection terminated unexpectedly");
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
  });

  it.each([
    ["botId", { botId: "bot-other" }],
    ["threadId", { threadId: "thread-other" }],
    ["scope", { scope: "shared" }],
  ])("未加密快照的 %s 与 run 不一致时退休、不发送", async (_field, change) => {
    const snapshot = buildTurnMemoryCapture(runRow(), {
      sourceMessage: { seq: 4, blocks: [{ kind: "text", text: "frozen q" }] },
      botMessages: [{ blocks: [{ kind: "text", text: "frozen a" }] }],
    })!;
    const { lifecycle, captureTurn } = lifecycleOf();
    const { prisma, rows } = fakePrisma([
      runRow({ memoryCapturePayload: { ...snapshot, ...change } }),
    ]);
    await captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-123");
    expect(captureTurn).not.toHaveBeenCalled();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("Prisma.DbNull 作为 CAS 条件：已有快照时不覆盖", async () => {
    const snapshot = buildTurnMemoryCapture(runRow(), {
      sourceMessage: { seq: 4, blocks: [{ kind: "text", text: "frozen q" }] },
      botMessages: [{ blocks: [{ kind: "text", text: "frozen a" }] }],
    })!;
    const { lifecycle, captureTurn } = lifecycleOf();
    const { prisma } = fakePrisma([runRow({ memoryCapturePayload: snapshot })]);
    await captureFinishedTurn({ prisma, memoryProviders: resolverOf(lifecycle) }, "run-123");
    expect(
      vi
        .mocked(prisma.run.updateMany)
        .mock.calls.filter(([args]: any) => args.data.memoryCapturePayload !== undefined),
    ).toEqual([]);
    expect(captureTurn.mock.calls[0]![0].query).toBe("frozen q");
    expect(Prisma.DbNull).toBeDefined();
  });
});
