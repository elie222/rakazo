import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  SecretStore,
  SemanticMemoryProvider,
  TurnMemoryCapture,
  TurnMemoryCaptureResult,
  TurnMemoryLifecycle,
  TurnMemoryRecall,
  TurnMemoryRecallRequest,
} from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { ContentKeyRing, ciphertextKeyId, LocalKeyProvider, Prisma } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";
import type { MemmySourceTurnBody } from "./memmy-memory-client.js";
import { createMemmyTurnMemory, MEMMY_PROVIDER_ID, memmyCaptureBody } from "./memmy-turn-memory.js";
import type { CaptureTurnRunRow, MemoryCapturePrisma } from "./memory-capture.js";
import {
  buildTurnMemoryCapture,
  captureFinishedTurn,
  MEMORY_CAPTURE_ANSWER_MAX_CHARS,
  MEMORY_CAPTURE_BATCH_SIZE,
  MEMORY_CAPTURE_MAX_TOOL_CALLS,
  MEMORY_CAPTURE_MAX_TOOL_RESULTS,
  MEMORY_CAPTURE_QUERY_MAX_CHARS,
  MEMORY_CAPTURE_TOOL_INPUT_MAX_CHARS,
  MEMORY_CAPTURE_TOOL_OUTPUT_MAX_CHARS,
} from "./memory-capture.js";
import type {
  ConfiguredMemoryProvider,
  MemoryProviderResolver,
  TurnMemoryAvailability,
} from "./memory-provider-factory.js";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";
import { recallTurnMemory } from "./run-context.js";
import { EncryptedSecretStore } from "./secrets.js";
import { userProgressClientNonce } from "./user-progress.js";

function makeRunRow(overrides: Partial<CaptureTurnRunRow> = {}): CaptureTurnRunRow {
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

function makeFakeLifecycle(
  captureResult: TurnMemoryCaptureResult = { status: "stored" },
): TurnMemoryLifecycle & {
  captureTurn: ReturnType<
    typeof vi.fn<
      (capture: TurnMemoryCapture, context: AdapterContext) => Promise<TurnMemoryCaptureResult>
    >
  >;
  beforeTurn: ReturnType<
    typeof vi.fn<
      (
        request: TurnMemoryRecallRequest,
        context: AdapterContext,
      ) => Promise<TurnMemoryRecall | null>
    >
  >;
} {
  return {
    beforeTurn: vi.fn(
      async (
        _request: TurnMemoryRecallRequest,
        _context: AdapterContext,
      ): Promise<TurnMemoryRecall | null> => ({
        sections: [],
        sourceMemoryIds: [],
      }),
    ),
    captureTurn: vi.fn(
      async (
        _capture: TurnMemoryCapture,
        _context: AdapterContext,
      ): Promise<TurnMemoryCaptureResult> => captureResult,
    ),
  };
}

function makeResolver(
  lifecycle?: TurnMemoryLifecycle,
  availability?: TurnMemoryAvailability,
): MemoryProviderResolver {
  const provider: SemanticMemoryProvider = {
    describe: () => ({
      id: "fake-memory",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      },
    }),
    recall: vi.fn(),
    save: vi.fn(),
    forget: vi.fn(),
    purgeHistory: vi.fn(),
  };
  return {
    resolveTurnMemory: vi.fn(
      async () =>
        availability ??
        (lifecycle
          ? { kind: "configured" as const, lifecycle, defaultScope: "isolated" as const }
          : { kind: "unconfigured" as const }),
    ),
    resolve: vi.fn(
      async (_spaceId: string): Promise<ConfiguredMemoryProvider | null> => ({
        provider,
        defaultScope: "isolated",
        ...(lifecycle ? { lifecycle } : {}),
      }),
    ),
  };
}

function makeFakeCapturePrisma(options: {
  run?: CaptureTurnRunRow | null;
  runs?: CaptureTurnRunRow[];
  sourceMessage?: { seq?: number; blocks: unknown } | null;
  botMessages?: Array<{ blocks: unknown; clientNonce?: string | null }>;
}): {
  prisma: MemoryCapturePrisma;
  runUpdate: ReturnType<typeof vi.fn>;
  rows: Map<string, CaptureTurnRunRow>;
} {
  const initial = options.runs ?? (options.run === null ? [] : [options.run ?? makeRunRow()]);
  const rows = new Map(initial.map((run) => [run.id, structuredClone(run)]));
  const runUpdate = vi.fn<MemoryCapturePrisma["run"]["update"]>(async ({ where, data }) => {
    const row = rows.get(where.id);
    if (!row) throw new Error(`Missing fixture run: ${where.id}`);
    Object.assign(row, data);
    if (row.memoryCapturePayload === Prisma.DbNull) row.memoryCapturePayload = null;
    return structuredClone(row);
  });
  const matches = (run: CaptureTurnRunRow, where: Prisma.RunWhereInput): boolean => {
    if (where.status !== undefined && run.status !== where.status) return false;
    if (where.threadId !== undefined && run.threadId !== where.threadId) return false;
    if (where.botId !== undefined && run.botId !== where.botId) return false;
    if (
      where.memoryCaptureScope !== undefined &&
      run.memoryCaptureScope !== where.memoryCaptureScope
    )
      return false;
    if (where.memoryCapturedAt === null && run.memoryCapturedAt !== null) return false;
    if (where.memoryCaptureDueAt) {
      if (run.memoryCaptureDueAt === null) return false;
      const filter = where.memoryCaptureDueAt;
      if (
        typeof filter === "object" &&
        "gte" in filter &&
        (filter.gte instanceof Date || typeof filter.gte === "string")
      ) {
        if (run.memoryCaptureDueAt < new Date(filter.gte)) return false;
      }
    }
    return !where.OR || where.OR.some((branch) => matches(run, branch));
  };
  const prisma: MemoryCapturePrisma = {
    run: {
      findUnique: vi.fn(async ({ where }) => structuredClone(rows.get(where.id) ?? null)),
      findMany: vi.fn(async ({ where, orderBy, take }) =>
        [...rows.values()]
          .filter((run) => matches(run, where))
          .sort((left, right) => {
            for (const order of orderBy) {
              const compared = order.memoryCaptureDueAt
                ? left.memoryCaptureDueAt!.getTime() - right.memoryCaptureDueAt!.getTime()
                : order.id
                  ? left.id.localeCompare(right.id)
                  : 0;
              if (compared) return compared;
            }
            return 0;
          })
          .slice(0, take)
          .map(({ id }) => ({ id })),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        expect(where.memoryCapturedAt).toBeNull();
        const row = rows.get(where.id);
        if (!row || row.memoryCapturedAt !== null) return { count: 0 };
        // The attempt counter and the snapshot freeze are both conditional writes here.
        if (data.memoryCaptureAttempts) {
          row.memoryCaptureAttempts =
            (row.memoryCaptureAttempts ?? 0) + data.memoryCaptureAttempts.increment;
          return { count: 1 };
        }
        expect(where.memoryCapturePayload?.equals).toBe(Prisma.DbNull);
        if (row.memoryCapturePayload !== null) return { count: 0 };
        row.memoryCapturePayload = structuredClone(data.memoryCapturePayload);
        return { count: 1 };
      }),
      update: runUpdate,
    },
    message: {
      findFirst: vi.fn(async () =>
        options.sourceMessage === undefined
          ? { seq: 4, blocks: [{ kind: "text", text: "How do we deploy Rakazo?" }] }
          : options.sourceMessage,
      ),
      findMany: vi.fn(async () =>
        options.botMessages === undefined
          ? [{ blocks: [{ kind: "text", text: "Use the release pipeline." }], clientNonce: null }]
          : options.botMessages,
      ),
    },
  };
  Object.assign(prisma, {
    secret: { findMany: vi.fn(async () => []) },
    purchase: { findMany: vi.fn(async () => []) },
  });
  return { prisma, runUpdate, rows };
}

function makeCaptureKeyRing() {
  const records: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) =>
      records
        .filter((row) => row.spaceId === spaceId)
        .sort((left, right) => left.version - right.version),
    byId: async (id) => records.find((row) => row.id === id),
    insert: async (record) => {
      const existing = records.find(
        (row) => row.spaceId === record.spaceId && row.version === record.version,
      );
      if (existing) return existing;
      records.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [
      ...new Map(records.map((row) => [row.masterKeyId, row])).values(),
    ],
  };
  const master = { id: "fixture-master-1", key: randomBytes(32) };
  return {
    store,
    records,
    master,
    ring: new ContentKeyRing(new LocalKeyProvider([master]), store),
  };
}

describe("turn-memory wiring", () => {
  it.each([
    { memoryCaptureDueAt: null },
    { memoryCapturedAt: new Date("2026-11-04T10:01:00.000Z") },
  ])("ignores runs outside the pending capture gate: %j", async (overrides) => {
    const lifecycle = makeFakeLifecycle();
    const resolver = makeResolver(lifecycle);
    const { prisma, runUpdate } = makeFakeCapturePrisma({ run: makeRunRow(overrides) });

    await captureFinishedTurn({ prisma, memoryProviders: resolver }, "run-123");

    expect(resolver.resolveTurnMemory).not.toHaveBeenCalled();
    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it("drains three pending turns by due time and then id", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [
        makeRunRow({ id: "run-3", memoryCaptureDueAt: new Date("2026-11-04T10:01:00Z") }),
        makeRunRow({ id: "run-2" }),
        makeRunRow({ id: "run-1" }),
      ],
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-3");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
    expect([...rows.values()].every((run) => run.memoryCapturedAt instanceof Date)).toBe(true);
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ memoryCaptureDueAt: "asc" }, { id: "asc" }],
        take: MEMORY_CAPTURE_BATCH_SIZE,
      }),
    );
  });

  it("stops at the second retryable turn and resumes it before later turns", async () => {
    const lifecycle = makeFakeLifecycle();
    lifecycle.captureTurn
      .mockResolvedValueOnce({ status: "stored" })
      .mockResolvedValueOnce({ status: "retryable", reason: "timeout" });
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: ["run-3", "run-2", "run-1"].map((id) => makeRunRow({ id })),
    });
    const deps = { prisma, memoryProviders: makeResolver(lifecycle) };

    await expect(captureFinishedTurn(deps, "run-3")).rejects.toThrow("retryable: run-2");
    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(rows.get("run-1")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-2")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-3")?.memoryCapturedAt).toBeNull();

    await captureFinishedTurn(deps, "run-3");
    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "run-1",
      "run-2",
      "run-2",
      "run-3",
    ]);
  });

  it("retires a provider TypeError, clears its snapshot, and continues with the next turn", async () => {
    const lifecycle = makeFakeLifecycle();
    lifecycle.captureTurn.mockRejectedValueOnce(new TypeError("fixture invalid provider state"));
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [makeRunRow({ id: "run-1" }), makeRunRow({ id: "run-2" })],
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-2");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "run-1",
      "run-2",
    ]);
    for (const id of ["run-1", "run-2"]) {
      expect(rows.get(id)?.memoryCapturedAt).toBeInstanceOf(Date);
      expect(rows.get(id)?.memoryCapturePayload).toBeNull();
    }
  });

  it("retains the current snapshot and stops draining when capture throws ECONNRESET", async () => {
    const lifecycle = makeFakeLifecycle();
    lifecycle.captureTurn.mockRejectedValueOnce(
      Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" }),
    );
    const { prisma, rows, runUpdate } = makeFakeCapturePrisma({
      runs: [makeRunRow({ id: "run-1" }), makeRunRow({ id: "run-2" })],
    });

    await expect(
      captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-2"),
    ).rejects.toThrow();

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual(["run-1"]);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(rows.get("run-1")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-1")?.memoryCapturePayload).toEqual(
      lifecycle.captureTurn.mock.calls[0]![0],
    );
    expect(rows.get("run-2")?.memoryCapturedAt).toBeNull();
    expect(rows.get("run-2")?.memoryCapturePayload).toBeNull();
  });

  it("drains shared turns independently for each bot while excluding other scopes and threads", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [
        makeRunRow({ id: "shared-2", memoryCaptureScope: "shared", botId: "bot-2" }),
        makeRunRow({ id: "shared-1", memoryCaptureScope: "shared" }),
        makeRunRow({ id: "isolated" }),
        makeRunRow({ id: "legacy", memoryCaptureScope: null }),
        makeRunRow({ id: "other-thread", memoryCaptureScope: "shared", threadId: "thread-2" }),
      ],
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "shared-2");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "shared-2",
    ]);
    expect(rows.get("shared-1")?.memoryCapturedAt).toBeNull();
    expect(rows.get("shared-2")?.memoryCapturedAt).toBeInstanceOf(Date);

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "shared-1");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "shared-2",
      "shared-1",
    ]);
    expect(rows.get("shared-1")?.memoryCapturedAt).toBeInstanceOf(Date);
    for (const id of ["isolated", "legacy", "other-thread"]) {
      expect(rows.get(id)?.memoryCapturedAt).toBeNull();
    }
  });

  it("allows another shared bot to finish while the first bot's oldest turn is retryable", async () => {
    const lifecycle = makeFakeLifecycle();
    lifecycle.captureTurn.mockImplementation(async (capture) =>
      capture.runId === "bot-a-oldest"
        ? { status: "retryable", reason: "provider_pending" }
        : { status: "stored" },
    );
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [
        makeRunRow({ id: "bot-a-oldest", botId: "bot-a", memoryCaptureScope: "shared" }),
        makeRunRow({
          id: "bot-a-later",
          botId: "bot-a",
          memoryCaptureScope: "shared",
          memoryCaptureDueAt: new Date("2026-11-04T10:01:00Z"),
        }),
        makeRunRow({
          id: "bot-b-turn",
          botId: "bot-b",
          memoryCaptureScope: "shared",
          memoryCaptureDueAt: new Date("2026-11-04T10:02:00Z"),
        }),
      ],
    });
    const deps = { prisma, memoryProviders: makeResolver(lifecycle) };

    await expect(captureFinishedTurn(deps, "bot-a-later")).rejects.toThrow(
      "retryable: bot-a-oldest",
    );
    await captureFinishedTurn(deps, "bot-b-turn");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "bot-a-oldest",
      "bot-b-turn",
    ]);
    expect(rows.get("bot-a-oldest")?.memoryCapturedAt).toBeNull();
    expect(rows.get("bot-a-later")?.memoryCapturedAt).toBeNull();
    expect(rows.get("bot-b-turn")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["run-a", "run-b"],
    ["run-b", "run-a"],
  ])(
    "captures overlapping shared turns independently in order %s then %s",
    async (first, second) => {
      const ledger = new Map<string, { startedAt: number; completedAt: number }>();
      const requests: MemmySourceTurnBody[] = [];
      const rejected: string[] = [];
      const complete = (turn: MemmySourceTurnBody["sourceTurn"]) => {
        const key = JSON.stringify([turn.source, turn.profileId, turn.conversationId]);
        const current = {
          startedAt: Date.parse(turn.startedAt),
          completedAt: Date.parse(turn.completedAt),
        };
        const previous = ledger.get(key);
        // Offline model of the checked timestamp rule; this is not a live Memmy server.
        if (
          previous &&
          (current.startedAt < previous.startedAt || current.completedAt < previous.completedAt)
        ) {
          rejected.push(turn.turnId);
          return { status: "pending", reason: "source_turn_out_of_order" };
        }
        ledger.set(key, current);
        return { status: "stored" };
      };
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe("http://127.0.0.1:18972/api/v1/source-turns/complete");
        const body = JSON.parse(String(init?.body)) as MemmySourceTurnBody;
        requests.push(body);
        return Response.json(complete(body.sourceTurn));
      });
      const lifecycle = createMemmyTurnMemory(
        { baseUrl: "http://127.0.0.1:18972", ownerId: "fixture-owner" },
        { token: "fixture-offline-token" },
        { fetch: fetchImpl },
      );
      const { prisma, rows } = makeFakeCapturePrisma({
        runs: [
          makeRunRow({
            id: "run-a",
            botId: "bot-a",
            memoryCaptureScope: "shared",
            startedAt: new Date("2026-11-04T10:00:01Z"),
            completedAt: new Date("2026-11-04T10:00:04Z"),
            memoryCaptureDueAt: new Date("2026-11-04T10:00:04Z"),
          }),
          makeRunRow({
            id: "run-b",
            botId: "bot-b",
            memoryCaptureScope: "shared",
            startedAt: new Date("2026-11-04T10:00:02Z"),
            completedAt: new Date("2026-11-04T10:00:03Z"),
            memoryCaptureDueAt: new Date("2026-11-04T10:00:03Z"),
          }),
        ],
      });
      const deps = { prisma, memoryProviders: makeResolver(lifecycle) };

      const legacyTurn = (runId: string): MemmySourceTurnBody["sourceTurn"] => {
        const run = rows.get(runId)!;
        return {
          source: "rakazo",
          profileId: "space:space-1",
          conversationId: run.threadId,
          turnId: run.id,
          startedAt: run.startedAt!.toISOString(),
          completedAt: run.completedAt!.toISOString(),
          completionEvidence: "run.completed",
        };
      };
      expect(complete(legacyTurn("run-b"))).toEqual({ status: "stored" });
      expect(complete(legacyTurn("run-a"))).toEqual({
        status: "pending",
        reason: "source_turn_out_of_order",
      });
      ledger.clear();
      rejected.length = 0;

      await captureFinishedTurn(deps, first);
      await captureFinishedTurn(deps, second);

      expect(requests.map((body) => body.sourceTurn.turnId)).toEqual([first, second]);
      expect(new Set(requests.map((body) => body.sourceTurn.profileId))).toEqual(
        new Set(["space:space-1"]),
      );
      expect(new Set(requests.map((body) => body.sourceTurn.conversationId)).size).toBe(2);
      expect(ledger.size).toBe(2);
      expect(rejected).toEqual([]);
      expect([...rows.values()].every((run) => run.memoryCapturedAt instanceof Date)).toBe(true);
    },
  );

  it("keeps isolated and legacy turns of one bot separate from shared or other-bot turns", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [
        makeRunRow({ id: "isolated" }),
        makeRunRow({ id: "legacy", memoryCaptureScope: null }),
        makeRunRow({ id: "shared", memoryCaptureScope: "shared" }),
        makeRunRow({ id: "other-bot", botId: "bot-2" }),
      ],
    });
    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "legacy");
    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual([
      "isolated",
      "legacy",
    ]);
    expect(
      lifecycle.captureTurn.mock.calls.every(([capture]) => capture.scope === "isolated"),
    ).toBe(true);
    expect(rows.get("shared")?.memoryCapturedAt).toBeNull();
    expect(rows.get("other-bot")?.memoryCapturedAt).toBeNull();
  });

  it("continues beyond a 25-turn batch and drains old turns outside the seven-day recovery window", async () => {
    const lifecycle = makeFakeLifecycle();
    const runs = Array.from({ length: 27 }, (_, index) =>
      makeRunRow({
        id: `run-${String(index).padStart(2, "0")}`,
        memoryCaptureDueAt: new Date(
          index === 26 ? "2026-11-04T10:01:00Z" : "2026-10-01T10:00:00Z",
        ),
      }),
    );
    const { prisma, rows } = makeFakeCapturePrisma({ runs: [...runs].reverse() });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-26");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual(
      runs.map((run) => run.id),
    );
    // 25 + 2 + one empty read: the drain now runs until the queue is empty.
    expect(prisma.run.findMany).toHaveBeenCalledTimes(3);
    expect([...rows.values()].every((run) => run.memoryCapturedAt instanceof Date)).toBe(true);
  });

  it.each([0, 4, undefined])(
    "preserves source sequence %s in the captured payload",
    async (seq) => {
      const lifecycle = makeFakeLifecycle();
      const { prisma } = makeFakeCapturePrisma({
        sourceMessage: { seq, blocks: [{ kind: "text", text: "Remember this" }] },
      });
      await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");
      expect(lifecycle.captureTurn.mock.calls[0]![0].sequence).toBe(seq);
    },
  );

  it.each([false, true])(
    "marks an empty query as handled even with tool calls: %s",
    async (hasTools) => {
      const lifecycle = makeFakeLifecycle();
      const { prisma, runUpdate } = makeFakeCapturePrisma({
        sourceMessage: { seq: 0, blocks: [{ kind: "text", text: "  " }] },
        ...(hasTools
          ? {
              botMessages: [
                { blocks: [{ kind: "steps", steps: [{ label: "shell", note: "not arguments" }] }] },
              ],
            }
          : {}),
      });

      await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

      expect(lifecycle.captureTurn).not.toHaveBeenCalled();
      expect(runUpdate).toHaveBeenCalledOnce();
    },
  );

  it("marks an unconfigured provider as handled without reading or sending evidence", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({});
    await captureFinishedTurn(
      {
        prisma,
        memoryProviders: makeResolver(lifecycle, { kind: "unconfigured" }),
      },
      "run-123",
    );
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
  });

  it.each(["dns_unavailable", "secret_store_unavailable"])(
    "keeps capture pending when provider resolution reports %s",
    async (reason) => {
      const lifecycle = makeFakeLifecycle();
      const { prisma, rows, runUpdate } = makeFakeCapturePrisma({});
      await expect(
        captureFinishedTurn(
          {
            prisma,
            memoryProviders: makeResolver(lifecycle, {
              kind: "unavailable",
              reason,
              retryable: true,
            }),
          },
          "run-123",
        ),
      ).rejects.toThrow("retryable: run-123");
      expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
      expect(runUpdate).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(prisma.run.updateMany)
          .mock.calls.filter(([args]: any) => args.data.memoryCapturePayload !== undefined),
      ).toEqual([]);
      expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    "lifecycle_unsupported",
    "private_endpoint_not_authorized",
    "unknown_provider",
    "invalid_credentials",
    "invalid_settings",
  ])("retires capture when provider resolution permanently fails: %s", async (reason) => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows, runUpdate } = makeFakeCapturePrisma({
      run: makeRunRow({ memoryCapturePayload: { query: "discarded pending snapshot" } }),
    });
    await expect(
      captureFinishedTurn(
        {
          prisma,
          memoryProviders: makeResolver(lifecycle, {
            kind: "unavailable",
            reason,
            retryable: false,
          }),
        },
        "run-123",
      ),
    ).resolves.toBeUndefined();
    expect(runUpdate).toHaveBeenCalledOnce();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it("retires an oldest turn with no owner and continues with the next turn", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [makeRunRow({ id: "run-1", userId: undefined }), makeRunRow({ id: "run-2" })],
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-2");

    expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual(["run-2"]);
    expect(rows.get("run-1")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-1")?.memoryCapturePayload).toBeNull();
    expect(rows.get("run-2")?.memoryCapturedAt).toBeInstanceOf(Date);
  });

  it("returns without reading or sending pending evidence when the conversation lock is held", async () => {
    const lifecycle = makeFakeLifecycle();
    const resolver = makeResolver(lifecycle);
    const { prisma, rows, runUpdate } = makeFakeCapturePrisma({});
    const lock = vi.fn(async <T>(_key: string, _run: () => Promise<T>) => ({
      acquired: false as const,
    }));

    await expect(
      captureFinishedTurn({ prisma, memoryProviders: resolver, lock }, "run-123"),
    ).resolves.toBeUndefined();

    expect(lock).toHaveBeenCalledExactlyOnceWith(
      "memory.capture:thread-1:bot-1",
      expect.any(Function),
    );
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(resolver.resolveTurnMemory).not.toHaveBeenCalled();
    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
  });

  it("retires a malformed snapshot without exposing its text and continues draining", async () => {
    const privateText = "fixture-private-malformed-snapshot";
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      runs: [
        makeRunRow({ id: "run-1", memoryCapturePayload: { query: privateText } }),
        makeRunRow({ id: "run-2" }),
      ],
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-2");
      expect(lifecycle.captureTurn.mock.calls.map(([capture]) => capture.runId)).toEqual(["run-2"]);
      expect(rows.get("run-1")?.memoryCapturedAt).toBeInstanceOf(Date);
      expect(rows.get("run-1")?.memoryCapturePayload).toBeNull();
      expect(JSON.stringify(sink.events)).not.toContain(privateText);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("retires a valid snapshot whose frozen target differs from its run", async () => {
    const snapshot = buildTurnMemoryCapture(makeRunRow(), {
      sourceMessage: { blocks: [{ kind: "text", text: "Frozen query" }] },
      botMessages: [{ blocks: [{ kind: "text", text: "Frozen answer" }] }],
    })!;
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({
      run: makeRunRow({ memoryCapturePayload: { ...snapshot, runId: "different-run" } }),
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("uses the finalized shared scope despite the provider's current isolated default", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma } = makeFakeCapturePrisma({
      run: makeRunRow({ memoryCaptureScope: "shared" }),
    });
    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");
    expect(lifecycle.captureTurn.mock.calls[0]![0].scope).toBe("shared");
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { memoryCapturePayload: expect.objectContaining({ scope: "shared" }) },
      }),
    );
  });

  it("replays the frozen redacted payload after an ACK loss despite secret and message changes", async () => {
    const secret = "fixture-first-capture-token";
    let currentSecret = secret;
    const sourceMessage = { seq: 4, blocks: [{ kind: "text", text: `Use ${secret}` }] };
    const botMessage = { blocks: [{ kind: "text", text: `Used ${secret}` }] };
    const { prisma, rows } = makeFakeCapturePrisma({ sourceMessage, botMessages: [botMessage] });
    const vaultFindMany = vi.fn(async () => [
      {
        id: "command-1",
        name: "capture-token",
        auth: { type: "command" },
        ciphertext: "fixture-ciphertext",
      },
    ]);
    Object.assign(prisma, {
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      vaultCredential: { findMany: vaultFindMany },
    });
    const secretStore = { load: vi.fn(async () => currentSecret) };
    const lifecycle = makeFakeLifecycle({ status: "existing" });
    lifecycle.captureTurn.mockResolvedValueOnce({ status: "retryable", reason: "ack_lost" });
    const deps = { prisma, memoryProviders: makeResolver(lifecycle), secretStore };

    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow("retryable: run-123");
    const first = JSON.stringify(lifecycle.captureTurn.mock.calls[0]![0]);
    expect(first).not.toContain(secret);
    expect(first).toContain("[redacted]");
    expect(rows.get("run-123")?.memoryCapturePayload).toEqual(
      lifecycle.captureTurn.mock.calls[0]![0],
    );
    expect(rows.get("run-123")?.memoryCapturedAt).toBeNull();
    const credentialReads = vaultFindMany.mock.calls.length;
    const secretReads = secretStore.load.mock.calls.length;
    currentSecret = "fixture-rotated-token";
    sourceMessage.blocks[0]!.text = "Edited query after first delivery";
    botMessage.blocks[0]!.text = "Edited answer after first delivery";

    await captureFinishedTurn(deps, "run-123");

    expect(JSON.stringify(lifecycle.captureTurn.mock.calls[1]![0])).toBe(first);
    expect(prisma.message.findFirst).toHaveBeenCalledOnce();
    expect(prisma.message.findMany).toHaveBeenCalledOnce();
    expect(vaultFindMany).toHaveBeenCalledTimes(credentialReads);
    expect(secretStore.load).toHaveBeenCalledTimes(secretReads);
    expect(
      vi
        .mocked(prisma.run.updateMany)
        .mock.calls.filter(([args]) => (args as any).data.memoryCapturePayload !== undefined)
        .length,
    ).toBe(1);
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("uses the persisted winner when another worker wins the snapshot CAS", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows } = makeFakeCapturePrisma({});
    const winner = buildTurnMemoryCapture(makeRunRow(), {
      sourceMessage: { seq: 4, blocks: [{ kind: "text", text: "Winner's frozen query" }] },
      botMessages: [{ blocks: [{ kind: "text", text: "Winner's frozen answer" }] }],
    })!;
    vi.mocked(prisma.run.updateMany).mockImplementationOnce(async ({ where }) => {
      expect(where.memoryCapturePayload?.equals).toBe(Prisma.DbNull);
      rows.get(where.id)!.memoryCapturePayload = structuredClone(winner);
      return { count: 0 };
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(lifecycle.captureTurn).toHaveBeenCalledOnce();
    expect(lifecycle.captureTurn.mock.calls[0]![0]).toEqual(winner);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("does not refreeze or resend after another worker completes and clears the snapshot", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, rows, runUpdate } = makeFakeCapturePrisma({});
    const capturedAt = new Date("2026-11-04T10:02:00Z");
    vi.mocked(prisma.run.updateMany).mockImplementationOnce(async ({ where }) => {
      expect(where.memoryCapturedAt).toBeNull();
      expect(where.memoryCapturePayload?.equals).toBe(Prisma.DbNull);
      const row = rows.get(where.id)!;
      row.memoryCapturedAt = capturedAt;
      row.memoryCapturePayload = null;
      return { count: 0 };
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(prisma.run.updateMany).toHaveBeenCalledOnce();
    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(rows.get("run-123")?.memoryCapturedAt).toEqual(capturedAt);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("encrypts the snapshot and replays it after both master and space key rotation", async () => {
    const lifecycle = makeFakeLifecycle({ status: "existing" });
    lifecycle.captureTurn.mockResolvedValueOnce({ status: "retryable", reason: "ack_lost" });
    const { prisma, rows } = makeFakeCapturePrisma({
      sourceMessage: { seq: 0, blocks: [{ kind: "text", text: "Confidential capture query" }] },
      botMessages: [{ blocks: [{ kind: "text", text: "Confidential capture answer" }] }],
    });
    const keys = makeCaptureKeyRing();
    let ring = keys.ring;
    Object.assign(prisma, { $contentEncryption: () => ({ ring }) });
    const deps = { prisma, memoryProviders: makeResolver(lifecycle) };

    await expect(captureFinishedTurn(deps, "run-123")).rejects.toThrow("retryable: run-123");
    const ciphertext = rows.get("run-123")!.memoryCapturePayload;
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toContain("Confidential capture query");
    expect(ciphertext).not.toContain("Confidential capture answer");
    const oldKeyId = ciphertextKeyId(ciphertext);
    expect(oldKeyId).toBeTruthy();
    const firstPayload = JSON.stringify(lifecycle.captureTurn.mock.calls[0]![0]);

    const master = { id: "fixture-master-2", key: randomBytes(32) };
    const rotated = new ContentKeyRing(new LocalKeyProvider([master, keys.master]), keys.store);
    const newKey = await rotated.rotate("space-1");
    expect(newKey.id).not.toBe(oldKeyId);
    expect(keys.records.find((record) => record.id === newKey.id)?.masterKeyId).toBe(master.id);
    // A fresh worker has no unwrapped-key cache and must unwrap the older stored key.
    ring = new ContentKeyRing(new LocalKeyProvider([master, keys.master]), keys.store);
    const byId = vi.spyOn(ring, "byId");

    await captureFinishedTurn(deps, "run-123");

    expect(byId).toHaveBeenCalledWith(oldKeyId);
    expect(JSON.stringify(lifecycle.captureTurn.mock.calls[1]![0])).toBe(firstPayload);
    expect(prisma.message.findFirst).toHaveBeenCalledOnce();
    expect(prisma.message.findMany).toHaveBeenCalledOnce();
    // Only the first turn froze a snapshot; the replay must not write another.
    expect(
      vi
        .mocked(prisma.run.updateMany)
        .mock.calls.filter(([args]) => (args as any).data.memoryCapturePayload !== undefined)
        .length,
    ).toBe(1);
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it.each([
    { label: "another run", overrides: { id: "run-other" } },
    { label: "another thread", overrides: { threadId: "thread-other" } },
  ])(
    "retires encrypted evidence copied to $label without sending it or exposing it in logs",
    async ({ overrides }) => {
      const keys = makeCaptureKeyRing();
      const original = makeFakeCapturePrisma({});
      Object.assign(original.prisma, { $contentEncryption: () => ({ ring: keys.ring }) });
      await expect(
        captureFinishedTurn(
          {
            prisma: original.prisma,
            memoryProviders: makeResolver(
              makeFakeLifecycle({ status: "retryable", reason: "ack_lost" }),
            ),
          },
          "run-123",
        ),
      ).rejects.toThrow("retryable: run-123");
      const ciphertext = original.rows.get("run-123")!.memoryCapturePayload;
      expect(ciphertextKeyId(ciphertext)).toBeTruthy();
      const target = makeRunRow({ ...overrides, memoryCapturePayload: ciphertext });
      const { prisma, rows, runUpdate } = makeFakeCapturePrisma({ run: target });
      Object.assign(prisma, { $contentEncryption: () => ({ ring: keys.ring }) });
      const lifecycle = makeFakeLifecycle();
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      try {
        await expect(
          captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, target.id),
        ).resolves.toBeUndefined();

        expect(lifecycle.captureTurn).not.toHaveBeenCalled();
        expect(prisma.message.findFirst).not.toHaveBeenCalled();
        expect(runUpdate).toHaveBeenCalledOnce();
        expect(rows.get(target.id)?.memoryCapturedAt).toBeInstanceOf(Date);
        expect(rows.get(target.id)?.memoryCapturePayload).toBeNull();
        expect(JSON.stringify(sink.events)).not.toContain(ciphertext);
        expect(JSON.stringify(sink.events)).not.toContain("How do we deploy Rakazo?");
      } finally {
        installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      }
    },
  );

  it("retires an encrypted snapshot whose old data key is no longer available", async () => {
    const keys = makeCaptureKeyRing();
    const { prisma, rows } = makeFakeCapturePrisma({});
    Object.assign(prisma, { $contentEncryption: () => ({ ring: keys.ring }) });
    await expect(
      captureFinishedTurn(
        {
          prisma,
          memoryProviders: makeResolver(
            makeFakeLifecycle({ status: "retryable", reason: "ack_lost" }),
          ),
        },
        "run-123",
      ),
    ).rejects.toThrow("retryable: run-123");
    expect(ciphertextKeyId(rows.get("run-123")?.memoryCapturePayload)).toBeTruthy();
    keys.records.length = 0;
    keys.ring.clear();
    const lifecycle = makeFakeLifecycle();

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(rows.get("run-123")?.memoryCapturedAt).toBeInstanceOf(Date);
    expect(rows.get("run-123")?.memoryCapturePayload).toBeNull();
  });

  it("preserves all non-progress answers in sequence and retains the progress-only fallback", () => {
    const sourceMessage = { seq: 0, blocks: [{ kind: "text", text: "What changed?" }] };
    const progress = {
      clientNonce: userProgressClientNonce("run-123", 1),
      blocks: [{ kind: "text", text: "Checking" }],
    };
    const botMessages = [
      { blocks: [{ kind: "text", text: "First finding" }] },
      progress,
      { blocks: [{ kind: "text", text: "Second finding" }] },
    ];

    expect(buildTurnMemoryCapture(makeRunRow(), { sourceMessage, botMessages })?.answer).toBe(
      "First finding\n\nSecond finding",
    );
    expect(
      buildTurnMemoryCapture(makeRunRow(), { sourceMessage, botMessages: [progress] })?.answer,
    ).toBe("Checking");
  });

  it("redacts and bounds every capture text and limits tool evidence counts", () => {
    const secret = "fake-capture-secret";
    const input = `${secret} ${"i".repeat(MEMORY_CAPTURE_TOOL_INPUT_MAX_CHARS)}`;
    const output = `${secret} ${"o".repeat(MEMORY_CAPTURE_TOOL_OUTPUT_MAX_CHARS)}`;
    const capture = buildTurnMemoryCapture(
      makeRunRow(),
      {
        sourceMessage: {
          seq: 0,
          blocks: [
            { kind: "text", text: `${secret} ${"q".repeat(MEMORY_CAPTURE_QUERY_MAX_CHARS)}` },
          ],
        },
        botMessages: [
          {
            blocks: [
              { kind: "text", text: `${secret} ${"a".repeat(MEMORY_CAPTURE_ANSWER_MAX_CHARS)}` },
              ...Array.from({ length: 45 }, (_, index) => ({
                kind: "subagent",
                agentId: `agent-${index}`,
                name: secret,
                task: input,
                status: "completed",
                result: output,
              })),
            ],
          },
        ],
      },
      "isolated",
      [secret],
    )!;

    expect(JSON.stringify(capture)).not.toContain(secret);
    expect(capture.query).toHaveLength(MEMORY_CAPTURE_QUERY_MAX_CHARS);
    expect(capture.answer).toHaveLength(MEMORY_CAPTURE_ANSWER_MAX_CHARS);
    expect(capture.toolCalls).toHaveLength(MEMORY_CAPTURE_MAX_TOOL_CALLS);
    expect(capture.toolResults).toHaveLength(MEMORY_CAPTURE_MAX_TOOL_RESULTS);
    expect(capture.toolCalls[0]!.input).toHaveLength(MEMORY_CAPTURE_TOOL_INPUT_MAX_CHARS);
    expect(capture.toolResults[0]!.output).toHaveLength(MEMORY_CAPTURE_TOOL_OUTPUT_MAX_CHARS);
    for (const text of [
      capture.query,
      capture.answer,
      capture.toolCalls[0]!.input,
      capture.toolResults[0]!.output,
    ]) {
      expect(text.endsWith("…")).toBe(true);
    }
  });

  it("loads saved login and command redactions through the encrypted secret store before capture", async () => {
    const password = "fake capture password";
    const token = "fake capture token";
    const secretStore = new EncryptedSecretStore("test-only-capture-key");
    const context: AdapterContext = {
      operationId: "test",
      traceId: "test",
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    };
    const login = await secretStore.put(
      encodeLoginSecret({ fields: [{ label: "Password", value: password, hidden: true }] }),
      context,
      { recordId: "login-capture" },
    );
    const command = await secretStore.put(token, context, { recordId: "command-capture" });
    const lifecycle = makeFakeLifecycle();
    const { prisma } = makeFakeCapturePrisma({
      sourceMessage: { seq: 0, blocks: [{ kind: "text", text: `${password} ${token}` }] },
      botMessages: [
        { blocks: [{ kind: "text", text: `${password} ${encodeURIComponent(token)}` }] },
      ],
    });
    Object.assign(prisma, {
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      vaultCredential: {
        findMany: vi.fn(async () => [
          { ...login, name: "login", auth: { type: "login" } },
          { ...command, name: "capture-token", auth: { type: "command" } },
        ]),
      },
    });
    const load = vi.spyOn(secretStore, "load");

    await captureFinishedTurn(
      { prisma, memoryProviders: makeResolver(lifecycle), secretStore },
      "run-123",
    );

    expect(load).toHaveBeenCalledWith(login.ciphertext, login.id);
    expect(load).toHaveBeenCalledWith(command.ciphertext, command.id);
    const capture = lifecycle.captureTurn.mock.calls[0]![0];
    expect(JSON.stringify(capture)).not.toContain(password);
    expect(JSON.stringify(capture)).not.toContain(token);
    expect(JSON.stringify(capture)).not.toContain(encodeURIComponent(token));
  });

  it("1. captureFinishedTurn skips non-completed runs without calling lifecycle.captureTurn", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, runUpdate } = makeFakeCapturePrisma({
      run: makeRunRow({ status: "failed" }),
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it("2. captureFinishedTurn throws on retryable result so the job queue retries and leaves memoryCapturedAt null", async () => {
    const lifecycle = makeFakeLifecycle({ status: "retryable", reason: "timeout" });
    const { prisma, runUpdate } = makeFakeCapturePrisma({});

    await expect(
      captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123"),
    ).rejects.toThrow("retryable: run-123");

    expect(lifecycle.captureTurn).toHaveBeenCalledOnce();
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it("3. captureFinishedTurn marks memoryCapturedAt and does not throw on terminal rejection", async () => {
    const lifecycle = makeFakeLifecycle({
      status: "terminal",
      reason: "source_turn_incomplete",
    });
    const { prisma, runUpdate } = makeFakeCapturePrisma({});

    await expect(
      captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123"),
    ).resolves.toBeUndefined();

    expect(lifecycle.captureTurn).toHaveBeenCalledOnce();
    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: "run-123" },
      data: { memoryCapturedAt: expect.any(Date), memoryCapturePayload: Prisma.DbNull },
    });
  });

  it("4. captureFinishedTurn marks memoryCapturedAt on existing status and passes runId as turnId and recallIds as sourceMemoryIds", async () => {
    const lifecycle = makeFakeLifecycle({ status: "existing" });
    const { prisma, runUpdate } = makeFakeCapturePrisma({
      run: makeRunRow({
        id: "run-idempotent-42",
        memoryRecallIds: ["mem-skill-1", "mem-l2-9"],
      }),
    });

    await captureFinishedTurn(
      { prisma, memoryProviders: makeResolver(lifecycle) },
      "run-idempotent-42",
    );

    expect(lifecycle.captureTurn).toHaveBeenCalledOnce();
    const [capture, context] = lifecycle.captureTurn.mock.calls[0]!;
    expect(capture.runId).toBe("run-idempotent-42");
    expect(capture.sourceMemoryIds).toEqual(["mem-skill-1", "mem-l2-9"]);
    expect(capture.sequence).toBe(4);

    const body = memmyCaptureBody(capture, { ownerId: "rakazo", spaceId: context.spaceId });
    expect(body.sourceTurn.turnId).toBe("run-idempotent-42");
    expect(body.sourceMemoryIds).toEqual(["mem-skill-1", "mem-l2-9"]);

    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: "run-idempotent-42" },
      data: { memoryCapturedAt: expect.any(Date), memoryCapturePayload: Prisma.DbNull },
    });
  });

  it("5. captureFinishedTurn skips lifecycle call and marks memoryCapturedAt when run has no sourceMessageId and no tool blocks", async () => {
    const lifecycle = makeFakeLifecycle();
    const { prisma, runUpdate } = makeFakeCapturePrisma({
      run: makeRunRow({ sourceMessageId: null }),
      sourceMessage: null,
      botMessages: [{ blocks: [{ kind: "text", text: "Scheduled routine summary" }] }],
    });

    await captureFinishedTurn({ prisma, memoryProviders: makeResolver(lifecycle) }, "run-123");

    expect(lifecycle.captureTurn).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith({
      where: { id: "run-123" },
      data: { memoryCapturedAt: expect.any(Date), memoryCapturePayload: Prisma.DbNull },
    });
  });

  it("extracts toolCalls and toolResults from persisted steps/subagent blocks and allows tools-only turns", () => {
    const capture = buildTurnMemoryCapture(
      makeRunRow({ sourceMessageId: "msg-user-1" }),
      {
        sourceMessage: { seq: 2, blocks: [{ kind: "text", text: "Run diagnostics" }] },
        botMessages: [
          {
            clientNonce: userProgressClientNonce("run-123", 1),
            blocks: [{ kind: "text", text: "Checking logs..." }],
          },
          {
            clientNonce: null,
            blocks: [
              {
                kind: "steps",
                steps: [
                  { label: "Running: pnpm check", count: 1, note: "exit 0" },
                  { label: "Reading package.json", count: 1 },
                ],
              },
              {
                kind: "subagent",
                agentId: "sub-1",
                name: "Verifier",
                task: "Verify adapter types",
                status: "completed",
                result: "All checks green",
              },
            ],
          },
        ],
      },
      "shared",
    );

    expect(capture).not.toBeNull();
    expect(capture?.scope).toBe("shared");
    expect(capture?.answer).toBe("Checking logs...");
    expect(capture?.toolCalls).toEqual([
      { name: "Running: pnpm check", input: "" },
      { name: "Reading package.json", input: "" },
      { name: "Verifier", input: "Verify adapter types" },
    ]);
    expect(capture?.toolResults).toEqual([{ name: "Verifier", output: "All checks green" }]);
  });

  it("recallTurnMemory returns null without throwing when beforeTurn throws", async () => {
    const lifecycle: TurnMemoryLifecycle = {
      beforeTurn: vi.fn(async () => {
        throw new Error("network down");
      }),
      captureTurn: vi.fn(),
    };
    const result = await recallTurnMemory(
      lifecycle,
      {
        query: "hello",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "space-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );
    expect(result).toBeNull();
  });

  it("SpaceMemoryProviderResolver exposes lifecycle for memmy provider", async () => {
    const previousAllow = process.env.MCP_ALLOW_PRIVATE_ENDPOINT;
    process.env.MCP_ALLOW_PRIVATE_ENDPOINT = "true";
    try {
      const prisma = {
        spaceMemoryConfig: {
          findUnique: vi.fn(async () => ({
            id: "cfg-1",
            provider: MEMMY_PROVIDER_ID,
            defaultMemoryScope: "isolated",
            settings: { baseUrl: "http://127.0.0.1:8080" },
            secret: {
              id: "secret-1",
              ciphertext: "cipher-1",
            },
          })),
        },
      } as unknown as PrismaClient;
      const secretStore = {
        load: vi.fn(async () => JSON.stringify({ token: "token-xyz" })),
      } as unknown as SecretStore;

      const resolver = new SpaceMemoryProviderResolver(prisma, secretStore);
      const resolved = await resolver.resolve("space-1");

      expect(resolved).not.toBeNull();
      expect(resolved?.lifecycle).toBeDefined();
      expect(typeof resolved?.lifecycle?.beforeTurn).toBe("function");
      expect(typeof resolved?.lifecycle?.captureTurn).toBe("function");
    } finally {
      if (previousAllow === undefined) delete process.env.MCP_ALLOW_PRIVATE_ENDPOINT;
      else process.env.MCP_ALLOW_PRIVATE_ENDPOINT = previousAllow;
    }
  });

  it("createJobReconciler enqueues memory.capture for completed runs with due capture and null capturedAt", async () => {
    const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (
        args.where &&
        "memoryCaptureDueAt" in args.where &&
        args.where.memoryCapturedAt === null
      ) {
        return [{ id: "run-due-capture" }];
      }
      return [];
    });
    const prisma = {
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 0 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "memory.capture",
      payload: { runId: "run-due-capture" },
      replaceKey: "memory.capture:run-due-capture",
      keepExisting: true,
      maxAttempts: 6,
    });
  });
});
