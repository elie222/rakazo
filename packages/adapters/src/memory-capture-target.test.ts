import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureTurnRunRow, MemoryCapturePrisma } from "./memory-capture.js";
import { buildTurnMemoryCapture, captureFinishedTurn } from "./memory-capture.js";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";

async function captureFixture() {
  vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "true");
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  const credentials = { token: "synthetic-original-token" };
  const config = {
    provider: "memmy",
    settings: { baseUrl: "http://127.0.0.1:8080", ownerId: "synthetic-owner" },
    defaultMemoryScope: "isolated",
    secret: { id: "synthetic-secret", ciphertext: "synthetic-sealed-credentials" },
  };
  const memoryProviders = new SpaceMemoryProviderResolver(
    {
      spaceMemoryConfig: { findUnique: vi.fn(async () => config) },
    } as unknown as PrismaClient,
    { load: vi.fn(async () => JSON.stringify(credentials)) } as never,
  );
  const configured = await memoryProviders.resolve("space-1");
  if (!configured?.captureTarget) throw new Error("Expected a resolved connection identity");
  const run: CaptureTurnRunRow = {
    id: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    botId: "bot-1",
    status: "completed",
    startedAt: new Date("2026-11-04T10:00:00Z"),
    completedAt: new Date("2026-11-04T10:00:05Z"),
    sourceMessageId: "message-1",
    memoryCaptureDueAt: new Date("2026-11-04T10:00:05Z"),
    memoryCapturedAt: null,
    memoryRecallIds: [],
    memoryCaptureScope: "isolated",
    memoryCaptureTarget: configured.captureTarget,
    memoryCapturePayload: null,
    memoryCaptureAttempts: 0,
  };
  run.memoryCapturePayload = buildTurnMemoryCapture(run, {
    sourceMessage: { seq: 1, blocks: [{ kind: "text", text: "Synthetic private question" }] },
    botMessages: [{ blocks: [{ kind: "text", text: "Synthetic private answer" }] }],
  });
  const prisma: MemoryCapturePrisma = {
    run: {
      findUnique: vi.fn(async () => structuredClone(run)),
      findMany: vi.fn(async () => (run.memoryCapturedAt === null ? [{ id: run.id }] : [])),
      updateMany: vi.fn(async ({ data }) => {
        if ("memoryCaptureAttempts" in data) {
          run.memoryCaptureAttempts =
            (run.memoryCaptureAttempts ?? 0) + data.memoryCaptureAttempts.increment;
        }
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => {
        run.memoryCapturedAt = data.memoryCapturedAt;
        run.memoryCapturePayload = null;
        return structuredClone(run);
      }),
    },
    message: { findMany: vi.fn(async () => []) },
  };
  // All credentialed requests terminate at this seam; no live endpoint is contacted.
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ status: "stored" }));
  vi.stubGlobal("fetch", fetchImpl);
  return { deps: { prisma, memoryProviders }, run, config, credentials, fetchImpl, sink };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("turn-memory capture connection identity", () => {
  it.each([null, undefined])(
    "retires an older unknown target %s instead of assigning it",
    async (target) => {
      const { deps, run, fetchImpl, sink } = await captureFixture();
      run.memoryCaptureTarget = target;

      await captureFinishedTurn(deps, run.id);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(run.memoryCapturedAt).toBeInstanceOf(Date);
      expect(run.memoryCapturePayload).toBeNull();
      expect(run.memoryCaptureAttempts).toBe(0);
      expect(JSON.stringify(sink.events)).toContain("capture_connection_changed");
    },
  );

  it("replays the frozen turn to the same target after credential rotation", async () => {
    const { deps, run, config, credentials, fetchImpl } = await captureFixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json({ reason: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "existing" }));
    const originalTarget = run.memoryCaptureTarget;
    const originalPayload = structuredClone(run.memoryCapturePayload);

    await expect(captureFinishedTurn(deps, run.id)).rejects.toThrow(
      "Turn memory capture retryable",
    );
    expect(run.memoryCapturedAt).toBeNull();
    expect(run.memoryCapturePayload).toEqual(originalPayload);
    credentials.token = "synthetic-rotated-token";
    config.secret = { id: "synthetic-rotated-secret", ciphertext: "synthetic-rotated-sealed" };
    await captureFinishedTurn(deps, run.id);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, first] = fetchImpl.mock.calls[0]!;
    const [secondUrl, second] = fetchImpl.mock.calls[1]!;
    expect(firstUrl).toBe(`${config.settings.baseUrl}/api/v1/source-turns/complete`);
    expect(secondUrl).toBe(firstUrl);
    expect(first?.headers).toMatchObject({ authorization: "Bearer synthetic-original-token" });
    expect(second?.headers).toMatchObject({ authorization: "Bearer synthetic-rotated-token" });
    const { requestId: firstId, ...firstBody } = JSON.parse(String(first?.body));
    const { requestId: secondId, ...secondBody } = JSON.parse(String(second?.body));
    expect(firstId).toEqual(expect.any(String));
    expect(secondId).toEqual(expect.any(String));
    expect(secondBody).toEqual(firstBody);
    expect(run.memoryCaptureTarget).toBe(originalTarget);
    // Only failed deliveries consume the per-turn budget; the successful replay does not.
    expect(run.memoryCaptureAttempts).toBe(1);
    expect(run.memoryCapturedAt).toBeInstanceOf(Date);
    expect(run.memoryCapturePayload).toBeNull();
  });

  it.each([
    ["baseUrl", "http://127.0.0.1:8081"],
    ["ownerId", "replacement-owner"],
  ] as const)("never sends an earlier turn after %s changes", async (key, value) => {
    const { deps, run, config, fetchImpl, sink, credentials } = await captureFixture();
    config.settings[key] = value;

    await captureFinishedTurn(deps, run.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(run.memoryCapturedAt).toBeInstanceOf(Date);
    expect(run.memoryCapturePayload).toBeNull();
    expect(run.memoryCaptureAttempts).toBe(0);
    expect(deps.prisma.message.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.run.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ memoryCaptureTarget: true }),
      }),
    );
    const logged = JSON.stringify(sink.events);
    expect(logged).toContain("capture_connection_changed");
    for (const privateValue of [
      config.settings.baseUrl,
      config.settings.ownerId,
      credentials.token,
      "Synthetic private question",
      run.memoryCaptureTarget!,
    ]) {
      expect(logged).not.toContain(privateValue);
    }
  });
});
