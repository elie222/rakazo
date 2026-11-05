import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureTurnRunRow, MemoryCapturePrisma } from "./memory-capture.js";
import { buildTurnMemoryCapture, captureFinishedTurn } from "./memory-capture.js";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";

// Only database I/O and HTTP are replaced. Real resolution, target binding, capture,
// acknowledgement and retry accounting run for every freshly constructed worker.
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "AND")
      return (filter as Record<string, unknown>[]).every((part) => matches(row, part));
    if (key === "OR")
      return (filter as Record<string, unknown>[]).some((part) => matches(row, part));
    const value = row[key];
    if (filter instanceof Date) return value instanceof Date && +value === +filter;
    if (filter === null || typeof filter !== "object") return value === filter;
    return Object.entries(filter as Record<string, unknown>).every(([op, expected]) => {
      if (op === "equals") return JSON.stringify(value) === JSON.stringify(expected);
      if (op === "not") return value !== expected;
      if (op === "lte") return value != null && Number(value) <= Number(expected);
      if (op === "gt") return value != null && Number(value) > Number(expected);
      return matches(value as Record<string, unknown>, { [op]: expected });
    });
  });
}

function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
  vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "true");
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  const config = {
    id: "config-1",
    spaceId: "space-1",
    provider: "memmy",
    settings: { baseUrl: "http://127.0.0.1:8080", ownerId: "synthetic-owner" },
    defaultMemoryScope: "isolated",
    secretId: "secret-1",
    secret: { id: "secret-1", ciphertext: "synthetic-sealed-credentials" },
    captureBackoffRevision: null as string | null,
    captureBackoffFailures: 0,
    captureBackoffUntil: null as Date | null,
    captureLeaseToken: null as string | null,
  };
  const configs = [config];
  const spaceMemoryConfig = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      structuredClone(configs.find((row) => matches(row, where)) ?? null),
    ),
    updateManyAndReturn: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = configs.filter((row) => matches(row, where));
        for (const row of rows) {
          for (const [key, value] of Object.entries(data)) {
            const increment = (value as { increment?: number } | null)?.increment;
            (row as Record<string, unknown>)[key] =
              increment === undefined
                ? value
                : Number((row as Record<string, unknown>)[key]) + increment;
          }
        }
        return structuredClone(rows);
      },
    ),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        count: (await spaceMemoryConfig.updateManyAndReturn(args)).length,
      }),
    ),
  };
  const credentials = new Map([["secret-1", "synthetic-wrong-token"]]);
  const worker = () =>
    new SpaceMemoryProviderResolver(
      { spaceMemoryConfig } as unknown as PrismaClient,
      {
        load: async (_ciphertext: string, id: string) =>
          JSON.stringify({ token: credentials.get(id) }),
      } as never,
    );
  const runs: CaptureTurnRunRow[] = [];
  const prisma: MemoryCapturePrisma = {
    run: {
      findUnique: vi.fn(async ({ where }) =>
        structuredClone(runs.find((run) => run.id === where.id) ?? null),
      ),
      findMany: vi.fn(async ({ where, take }) =>
        runs
          .filter((run) =>
            matches(run as unknown as Record<string, unknown>, where as Record<string, unknown>),
          )
          .sort(
            (a, b) => +a.memoryCaptureDueAt! - +b.memoryCaptureDueAt! || a.id.localeCompare(b.id),
          )
          .slice(0, take)
          .map(({ id }) => ({ id })),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const run = runs.find((row) => row.id === where.id && row.memoryCapturedAt === null);
        if (!run) return { count: 0 };
        if ("memoryCaptureAttempts" in data)
          run.memoryCaptureAttempts =
            (run.memoryCaptureAttempts ?? 0) + data.memoryCaptureAttempts.increment;
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const run = runs.find((row) => row.id === where.id)!;
        run.memoryCapturedAt = data.memoryCapturedAt;
        run.memoryCapturePayload = null;
        return structuredClone(run);
      }),
    },
    message: { findMany: vi.fn(async () => []) },
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 }));
  vi.stubGlobal("fetch", fetchImpl);
  const addRun = async (overrides: Partial<CaptureTurnRunRow> = {}) => {
    const spaceId = overrides.spaceId ?? "space-1";
    const availability = await worker().resolveTurnMemory(spaceId);
    if (availability.kind !== "configured") throw new Error("Expected a configured lifecycle");
    const run: CaptureTurnRunRow = {
      id: `run-${runs.length}`,
      spaceId,
      userId: "synthetic-user",
      threadId: `thread-${runs.length}`,
      botId: "bot-1",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      sourceMessageId: null,
      memoryCaptureDueAt: new Date(),
      memoryCapturedAt: null,
      memoryRecallIds: [],
      memoryCaptureScope: "isolated",
      memoryCaptureTarget: availability.captureTarget,
      memoryCapturePayload: null,
      memoryCaptureAttempts: 0,
      ...overrides,
    };
    run.memoryCapturePayload = buildTurnMemoryCapture(
      run,
      {
        sourceMessage: { seq: 1, blocks: [{ kind: "text", text: "Synthetic question" }] },
        botMessages: [{ blocks: [{ kind: "text", text: "Synthetic answer" }] }],
      },
      run.memoryCaptureScope === "shared" ? "shared" : "isolated",
    );
    runs.push(run);
    return run;
  };
  const attempt = async (run: CaptureTurnRunRow, memoryProviders = worker()) => {
    await captureFinishedTurn({ prisma, memoryProviders }, run.id).catch((error) => {
      if (!(error instanceof Error && error.message.includes("Turn memory capture retryable")))
        throw error;
    });
  };
  return {
    config,
    configs,
    credentials,
    spaceMemoryConfig,
    worker,
    prisma,
    runs,
    addRun,
    attempt,
    fetchImpl,
    sink,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("durable connection-level capture backoff", () => {
  it.each([401, 403, 404])(
    "preserves evidence without repeated HTTP after worker restarts on %s",
    async (status) => {
      const f = fixture();
      f.fetchImpl.mockImplementation(async () => Response.json({}, { status }));
      const run = await f.addRun();
      const payload = structuredClone(run.memoryCapturePayload);
      for (let restart = 0; restart < 12; restart += 1) await f.attempt(run);

      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.config.captureBackoffUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(f.config.captureBackoffFailures).toBe(1);
      expect(run.memoryCapturedAt).toBeNull();
      expect(run.memoryCaptureAttempts).toBe(0);
      expect(run.memoryCapturePayload).toEqual(payload);
    },
  );

  it("persists increasing capped delays across fresh workers and recovers on an unchanged connection", async () => {
    const f = fixture();
    const run = await f.addRun();
    for (let failure = 0; failure < 9; failure += 1) {
      const now = Date.now();
      await f.attempt(run);
      const delay = Math.min(60_000 * 2 ** failure, 3_600_000);
      expect(f.config.captureBackoffUntil!.getTime()).toBe(now + delay);
      expect(f.config.captureBackoffFailures).toBe(failure + 1);
      vi.setSystemTime(new Date(now + delay - 1));
      await f.attempt(run);
      expect(f.fetchImpl).toHaveBeenCalledTimes(failure + 1);
      vi.setSystemTime(new Date(now + delay));
    }
    f.fetchImpl.mockResolvedValue(Response.json({ status: "existing" }));
    await f.attempt(run);
    expect(f.fetchImpl).toHaveBeenCalledTimes(10);
    expect(run.memoryCapturedAt).toBeInstanceOf(Date);
    expect(run.memoryCaptureAttempts).toBe(0);
    expect(f.config.captureBackoffFailures).toBe(0);
    expect(f.config.captureBackoffUntil).toBeNull();
    expect(f.config.captureLeaseToken).toBeNull();
  });

  it("shares a pause across bots, threads and capture scopes, not independent connections", async () => {
    const f = fixture();
    const broken = await f.addRun();
    const sibling = await f.addRun({ botId: "other-bot", memoryCaptureScope: "shared" });
    const independent = structuredClone(f.config);
    independent.id = "config-2";
    independent.spaceId = "space-2";
    independent.secretId = "secret-2";
    independent.secret = { id: "secret-2", ciphertext: "synthetic-independent-sealed" };
    f.configs.push(independent);
    f.credentials.set("secret-2", "synthetic-good-token");
    const healthy = await f.addRun({ spaceId: "space-2" });
    f.fetchImpl.mockImplementation(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer synthetic-good-token"
        ? Response.json({ status: "stored" })
        : Response.json({}, { status: 403 }),
    );

    await f.attempt(broken);
    await f.attempt(sibling);
    await f.attempt(healthy);

    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(broken.memoryCapturedAt).toBeNull();
    expect(sibling.memoryCapturedAt).toBeNull();
    expect(sibling.memoryCaptureAttempts).toBe(0);
    expect(healthy.memoryCapturedAt).toBeInstanceOf(Date);
    expect(f.config.captureBackoffFailures).toBe(1);
    expect(independent.captureBackoffFailures).toBe(0);
  });

  it.each(["secretId", "ciphertext"] as const)(
    "immediately recovers after %s repair without rebinding the frozen evidence",
    async (repair) => {
      const f = fixture();
      const run = await f.addRun();
      const payload = structuredClone(run.memoryCapturePayload);
      const target = run.memoryCaptureTarget;
      await f.attempt(run);
      const oldRevision = f.config.captureBackoffRevision;
      expect(f.config.captureBackoffUntil!.getTime()).toBeGreaterThan(Date.now());
      if (repair === "secretId") {
        f.config.secretId = "repaired-secret";
        f.config.secret.id = "repaired-secret";
      }
      f.config.secret.ciphertext = "synthetic-repaired-sealed";
      f.credentials.set(f.config.secret.id, "synthetic-repaired-token");
      f.fetchImpl.mockResolvedValue(Response.json({ status: "stored" }));
      await f.attempt(run);

      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
      expect(f.config.captureBackoffRevision).not.toBe(oldRevision);
      expect(f.config.captureBackoffRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(run.memoryCaptureTarget).toBe(target);
      expect(run.memoryCapturedAt).toBeInstanceOf(Date);
      expect(run.memoryCaptureAttempts).toBe(0);
      const request = JSON.parse(String(f.fetchImpl.mock.calls[1]![1]?.body));
      expect(request.query).toBe((payload as { query: string }).query);
      expect(request.answer).toBe((payload as { answer: string }).answer);
      const logs = JSON.stringify(f.sink.events);
      for (const sensitive of [
        "synthetic-wrong-token",
        "synthetic-repaired-token",
        "synthetic-repaired-sealed",
        f.config.captureBackoffRevision!,
        "Synthetic question",
      ]) {
        expect(logs).not.toContain(sensitive);
      }
    },
  );

  it("allows one in-flight probe per connection without holding unrelated connections", async () => {
    const f = fixture();
    const first = await f.addRun();
    const sibling = await f.addRun({ memoryCaptureScope: "shared", botId: "other-bot" });
    const independent = structuredClone(f.config);
    independent.id = "config-2";
    independent.spaceId = "space-2";
    independent.secretId = "secret-2";
    independent.secret = { id: "secret-2", ciphertext: "synthetic-independent-sealed" };
    f.configs.push(independent);
    f.credentials.set("secret-2", "synthetic-independent-token");
    const healthy = await f.addRun({ spaceId: "space-2" });
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    f.fetchImpl.mockResolvedValue(Response.json({ status: "stored" }));
    f.fetchImpl.mockImplementationOnce(() => {
      entered();
      return pending;
    });

    const inFlight = f.attempt(first);
    await started;
    await Promise.all([f.attempt(sibling), f.attempt(healthy)]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(sibling.memoryCapturedAt).toBeNull();
    expect(sibling.memoryCaptureAttempts).toBe(0);
    expect(healthy.memoryCapturedAt).toBeInstanceOf(Date);
    release(Response.json({}, { status: 401 }));
    await inFlight;
    await f.attempt(sibling);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.config.captureBackoffFailures).toBe(1);
  });

  it("recovers an expired worker lease and fences its late result from the newer cooldown", async () => {
    const f = fixture();
    const first = await f.addRun();
    const sibling = await f.addRun();
    const competitor = await f.addRun();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    f.fetchImpl.mockImplementationOnce(() => {
      entered();
      return pending;
    });
    const inFlight = f.attempt(first);
    await started;
    const leaseExpiry = f.config.captureBackoffUntil!;
    vi.setSystemTime(leaseExpiry);
    await Promise.all([f.attempt(sibling), f.attempt(competitor)]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const newerCooldown = f.config.captureBackoffUntil;
    expect(f.config.captureBackoffFailures).toBe(1);

    release(Response.json({ status: "stored" }));
    await inFlight;
    expect(f.config.captureBackoffUntil).toEqual(newerCooldown);
    expect(f.config.captureBackoffFailures).toBe(1);
    await f.attempt(competitor);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(competitor.memoryCaptureAttempts).toBe(0);
  });

  it("does not let an old credential result overwrite a repaired connection's cooldown", async () => {
    const f = fixture();
    const old = await f.addRun();
    const repaired = await f.addRun();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    f.fetchImpl.mockImplementationOnce(() => {
      entered();
      return pending;
    });
    const inFlight = f.attempt(old);
    await started;
    f.config.secretId = "repaired-secret";
    f.config.secret = { id: "repaired-secret", ciphertext: "synthetic-repaired-sealed" };
    f.credentials.set("repaired-secret", "synthetic-second-wrong-token");
    await f.attempt(repaired);
    const repairedRevision = f.config.captureBackoffRevision;
    const repairedCooldown = f.config.captureBackoffUntil;
    release(Response.json({}, { status: 403 }));
    await inFlight;

    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.config.captureBackoffRevision).toBe(repairedRevision);
    expect(f.config.captureBackoffUntil).toEqual(repairedCooldown);
    expect(f.config.captureBackoffFailures).toBe(1);
    expect(old.memoryCaptureAttempts).toBe(0);
    expect(old.memoryCapturedAt).toBeNull();
  });

  it("checks the resolved configuration again before sending a stale credential", async () => {
    const f = fixture();
    const run = await f.addRun();
    const resolved = await f.worker().resolveTurnMemory(run.spaceId);
    f.config.secretId = "replacement-secret";
    f.config.secret = { id: "replacement-secret", ciphertext: "synthetic-replacement-sealed" };
    const staleResolver = { resolve: async () => null, resolveTurnMemory: async () => resolved };
    await captureFinishedTurn({ prisma: f.prisma, memoryProviders: staleResolver }, run.id);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(run.memoryCapturedAt).toBeNull();
    expect(run.memoryCaptureAttempts).toBe(0);
    expect(f.config.captureBackoffRevision).toBeNull();
  });

  it("repairs settings for new turns without retargeting old pending evidence", async () => {
    const f = fixture();
    const old = await f.addRun();
    await f.attempt(old);
    f.config.settings.ownerId = "synthetic-replacement-owner";
    const replacement = await f.addRun();
    f.fetchImpl.mockResolvedValue(Response.json({ status: "stored" }));
    await f.attempt(old);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    await f.attempt(replacement);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(old.memoryCaptureTarget).not.toBe(replacement.memoryCaptureTarget);
    expect(replacement.memoryCapturedAt).toBeInstanceOf(Date);
    expect(f.config.captureBackoffUntil).toBeNull();
  });

  it("keeps the durable probe lease when persisting a connection failure fails", async () => {
    const f = fixture();
    const run = await f.addRun();
    const update = f.spaceMemoryConfig.updateMany.getMockImplementation()!;
    f.spaceMemoryConfig.updateMany
      .mockImplementationOnce(update)
      .mockRejectedValueOnce(new Error("synthetic result write failure"));
    await expect(f.attempt(run)).rejects.toThrow("synthetic result write failure");
    expect(f.config.captureBackoffUntil).toBeInstanceOf(Date);
    expect(f.config.captureBackoffUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(f.config.captureLeaseToken).not.toBeNull();
    await f.attempt(run);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.memoryCapturedAt).toBeNull();
    expect(run.memoryCaptureAttempts).toBe(0);
    expect(run.memoryCapturePayload).not.toBeNull();
  });

  it("fails closed on scheduling database errors instead of retiring pending evidence", async () => {
    const f = fixture();
    const run = await f.addRun();
    f.spaceMemoryConfig.updateMany.mockRejectedValueOnce(new Error("synthetic database failure"));
    await expect(f.attempt(run)).rejects.toThrow("synthetic database failure");
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(run.memoryCapturedAt).toBeNull();
    expect(run.memoryCapturePayload).not.toBeNull();
    expect(run.memoryCaptureAttempts).toBe(0);
    f.fetchImpl.mockResolvedValue(Response.json({ status: "stored" }));
    await f.attempt(run);
    expect(run.memoryCapturedAt).toBeInstanceOf(Date);
  });
});
