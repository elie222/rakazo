import { randomBytes } from "node:crypto";
import type { AdapterContext, TurnMemoryCapture } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { FinalizeRunInput, PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  ContentKeyRing,
  ciphertextKeyId,
  clearThread,
  decryptText,
  finalizeRun,
  LocalKeyProvider,
  Prisma,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadLoginPasswordRedactions } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import type { CaptureTurnRunRow, MemoryCapturePrisma } from "./memory-capture.js";
import { captureFinishedTurn } from "./memory-capture.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun } from "./run-turn.js";
import { EncryptedSecretStore } from "./secrets.js";

const owner = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const marker = "synthetic-previous-password+revision";
const context: AdapterContext = {
  ...owner,
  operationId: "fixture",
  traceId: "fixture",
  signal: new AbortController().signal,
};

async function completionFixture() {
  const db = fakeDatabase();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const credentialId = "synthetic-saved-login";
  const stored = await secretStore.put(
    encodeLoginSecret({ fields: [{ label: "Password", value: marker, hidden: true }] }),
    context,
    { recordId: credentialId },
  );
  await db.prisma.vaultCredential.create({
    data: {
      id: credentialId,
      ...owner,
      spaceId: null,
      name: "fixture_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
      ciphertext: stored.ciphertext,
    },
  } as never);
  // The real executor retains this in-memory set for the life of the turn.
  const redactions = await loadLoginPasswordRedactions(db.prisma, secretStore, owner);
  const row: CaptureTurnRunRow & { leaseOwner: string | null; leaseFence: number } = {
    ...owner,
    id: "run-1",
    threadId: "thread-1",
    status: "running",
    startedAt: new Date("2026-11-04T10:00:00Z"),
    completedAt: null,
    createdAt: new Date("2026-11-04T09:59:59Z"),
    sourceMessageId: "source-1",
    memoryCaptureDueAt: null,
    memoryCapturedAt: null,
    memoryCaptureScope: null,
    memoryCaptureTarget: null,
    memoryRecallIds: null,
    memoryCapturePayload: null,
    leaseOwner: "worker-1",
    leaseFence: 1,
  };
  const source = {
    id: "source-1",
    threadId: row.threadId,
    seq: 7,
    role: "user",
    blocks: [{ kind: "text", text: `Use the saved login ${marker} to complete the task.` }],
  };
  const botMessages: Array<{ blocks: unknown; clientNonce: string | null }> = [];
  const records: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => records.filter((r) => r.spaceId === spaceId),
    byId: async (id) => records.find((r) => r.id === id),
    insert: async (record) => {
      records.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => records.slice(0, 1),
  };
  const ring = new ContentKeyRing(
    new LocalKeyProvider([{ id: "fixture-master", key: randomBytes(32) }]),
    store,
  );
  const attemptUpdate = vi.fn(async () => ({ count: 1 }));
  const run = {
    findUnique: vi.fn(async () => structuredClone(row)),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async ({ where }) =>
      typeof where.status === "object"
        ? []
        : row.memoryCaptureDueAt && row.memoryCapturedAt === null
          ? [{ id: row.id }]
          : [],
    ),
    updateMany: vi.fn(async ({ where, data }) => {
      if (
        where.status &&
        (row.status !== where.status ||
          row.leaseOwner !== where.leaseOwner ||
          row.leaseFence !== where.leaseFence)
      )
        return { count: 0 };
      if (where.memoryCapturedAt === null && row.memoryCapturedAt !== null) return { count: 0 };
      if (where.memoryCapturePayload && row.memoryCapturePayload !== null) return { count: 0 };
      Object.assign(row, data);
      if (row.memoryCapturePayload === Prisma.DbNull) row.memoryCapturePayload = null;
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) => {
      Object.assign(row, data);
      if (row.memoryCapturePayload === Prisma.DbNull) row.memoryCapturePayload = null;
      return structuredClone(row);
    }),
  };
  const message = {
    findFirst: vi.fn(async () => structuredClone(source)),
    findMany: vi.fn(async () => structuredClone(botMessages)),
    create: vi.fn(async ({ data }) => {
      botMessages.push({
        blocks: structuredClone(data.blocks),
        clientNonce: data.clientNonce ?? null,
      });
      return { id: "final-1", ...data };
    }),
    deleteMany: vi.fn(async () => {
      source.blocks = [];
      botMessages.splice(0);
      return { count: 2 };
    }),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run,
    message,
    attempt: { updateMany: attemptUpdate },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: 9,
        nextEventSeq: 1,
        historyCompactionGeneration: 0,
        userId: owner.userId,
      })),
    },
    event: {
      create: vi.fn(async ({ data }) => ({
        id: "event-1",
        createdAt: new Date(),
        threadId: row.threadId,
        seq: 0,
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    secret: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    purchase: { findMany: vi.fn(async () => []) },
    steeringMessage: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    bot: { update: vi.fn(async () => ({})) },
  };
  const prisma = Object.assign(db.prisma, {
    ...tx,
    $contentEncryption: () => ({ ring }),
    thread: {
      ...tx.thread,
      findUniqueOrThrow: async () => ({ nextMessageSeq: 9, historyCompactedUpToSeq: null }),
    },
    // This model provides rollback for the unit fixture, not a PostgreSQL proof.
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      const before = structuredClone(row);
      const beforeMessages = structuredClone(botMessages);
      try {
        return await operation(tx);
      } catch (error) {
        Object.assign(row, before);
        botMessages.splice(0, botMessages.length, ...beforeMessages);
        throw error;
      }
    },
  });
  const captureTurn = vi.fn(async (_capture: TurnMemoryCapture) => ({ status: "stored" as const }));
  const memoryProviders: MemoryProviderResolver = {
    resolve: vi.fn(async () => null),
    resolveTurnMemory: vi.fn(async () => ({
      kind: "configured" as const,
      defaultScope: "isolated" as const,
      captureTarget: "fixture-target",
      lifecycle: { beforeTurn: vi.fn(async () => null), captureTurn },
    })),
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    events: {
      finalizeRun: (input: FinalizeRunInput) =>
        finalizeRun(prisma as unknown as PrismaClient, input),
    },
    jobs: { enqueue },
  };
  const runtimeRun = { ...row, taskId: "task-1", trigger: "user", clientNonce: null };
  const reply = await createReplyState(deps as never, runtimeRun as never, redactions);
  // This reply is not persisted until the real finalizeRun transaction creates it.
  reply.assembled = "Completed without echoing a credential.";
  reply.messageSegments = [{ kind: "text", text: reply.assembled }];
  const ctx = {
    deps,
    run: runtimeRun,
    runId: row.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: row.botId, name: "Fixture bot" },
    thread: { id: row.threadId },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
      handedOff: false,
    },
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    secrets: redactions,
    memory: {
      scope: "isolated",
      captureEligible: true,
      captureTarget: "fixture-target",
      injectedIds: ["memory-1"],
    },
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return {
    row,
    source,
    botMessages,
    ring,
    prisma,
    tx,
    ctx,
    run,
    message,
    enqueue,
    captureTurn,
    attemptUpdate,
    secretStore,
    deps: { prisma: prisma as unknown as MemoryCapturePrisma, memoryProviders, secretStore },
    async rotate(operation: "replace" | "delete") {
      if (operation === "delete")
        await db.prisma.vaultCredential.deleteMany({ where: { id: credentialId } });
      else {
        const replacement = await secretStore.put(
          encodeLoginSecret({
            fields: [{ label: "Password", value: "synthetic-replacement-password", hidden: true }],
          }),
          context,
          { recordId: credentialId },
        );
        await db.prisma.vaultCredential.update({
          where: { id: credentialId },
          data: { ciphertext: replacement.ciphertext },
        });
      }
    },
  };
}

describe("capture snapshot at completion", () => {
  it("retains only an encrypted redacted snapshot before any worker or vault reread", async () => {
    const fixture = await completionFixture();
    // Rotate even before completion: only the executor's in-memory set knows the old value.
    await fixture.rotate("replace");
    await completeRun(fixture.ctx);
    expect(ciphertextKeyId(fixture.row.memoryCapturePayload)).toBeTruthy();
    expect(fixture.row.memoryCaptureDueAt).toEqual(fixture.row.completedAt);
    expect(fixture.captureTurn).not.toHaveBeenCalled();
    const load = vi
      .spyOn(fixture.secretStore, "load")
      .mockRejectedValue(new Error("vault must not be reread"));
    fixture.message.findFirst.mockRejectedValue(new Error("source must not be reread"));
    fixture.message.findMany.mockRejectedValue(new Error("reply must not be reread"));
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    expect(JSON.stringify(fixture.captureTurn.mock.calls)).not.toContain(marker);
    expect(load).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.run.update.mock.calls)).not.toContain(marker);
  });

  it("keeps the temporary-run-secret no-capture guard and deletes the secret rows", async () => {
    const fixture = await completionFixture();
    fixture.tx.secret.findFirst.mockResolvedValue({ id: "run-only-secret" });
    await completeRun(fixture.ctx);
    expect(fixture.row.status).toBe("completed");
    expect(fixture.row.memoryCaptureDueAt).toBeNull();
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.tx.secret.deleteMany).toHaveBeenCalled();
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    expect(fixture.captureTurn).not.toHaveBeenCalled();
  });

  it("does not snapshot a completion that loses its lease", async () => {
    const fixture = await completionFixture();
    fixture.row.leaseFence = 2;
    await completeRun(fixture.ctx);
    expect(fixture.row.status).toBe("running");
    expect(fixture.row.memoryCaptureDueAt).toBeNull();
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.message.create).not.toHaveBeenCalled();
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("does not snapshot a run cancelled by a clear that won the thread lock", async () => {
    const fixture = await completionFixture();
    fixture.row.status = "cancelled";
    await completeRun(fixture.ctx);
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.message.create).not.toHaveBeenCalled();
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("declines capture if the source was removed before finalization", async () => {
    const fixture = await completionFixture();
    fixture.message.findFirst.mockResolvedValue(null as never);
    await completeRun(fixture.ctx);
    expect(fixture.row.status).toBe("completed");
    expect(fixture.row.memoryCaptureDueAt).toBeNull();
    expect(fixture.row.memoryCapturePayload).toBeNull();
  });

  it("rolls back completion, final reply and capture if snapshot encryption fails", async () => {
    const fixture = await completionFixture();
    vi.spyOn(fixture.ring, "current").mockRejectedValue(new Error("synthetic key-store failure"));
    await expect(completeRun(fixture.ctx)).rejects.toThrow("synthetic key-store failure");
    expect(fixture.row.status).toBe("running");
    expect(fixture.row.completedAt).toBeNull();
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.botMessages).toHaveLength(0);
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("rolls back an already-built snapshot if a later finalization write fails", async () => {
    const fixture = await completionFixture();
    fixture.tx.bot.update.mockImplementationOnce(async () => {
      expect(ciphertextKeyId(fixture.row.memoryCapturePayload)).toBeTruthy();
      throw new Error("synthetic late finalization failure");
    });
    await expect(completeRun(fixture.ctx)).rejects.toThrow("synthetic late finalization failure");
    expect(fixture.row.status).toBe("running");
    expect(fixture.row.memoryCaptureDueAt).toBeNull();
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.botMessages).toHaveLength(0);
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("rebuilds completion snapshots after a transaction conflict without duplicating the final reply", async () => {
    const fixture = await completionFixture();
    fixture.tx.bot.update.mockRejectedValueOnce(
      Object.assign(new Error("synthetic serialization conflict"), { code: "P2034" }),
    );
    await completeRun(fixture.ctx);
    expect(fixture.run.update).toHaveBeenCalledTimes(2);
    expect(fixture.botMessages).toHaveLength(1);
    expect(fixture.row.memoryCaptureDueAt).toEqual(fixture.row.completedAt);
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    const capture = fixture.captureTurn.mock.calls[0]![0];
    expect(capture.completedAt).toBe(fixture.row.completedAt!.toISOString());
    expect(capture.answer).toBe("Completed without echoing a credential.");
    expect(capture.query).not.toContain(marker);
  });

  it("clears the durable snapshot with chat history before the first worker reads it", async () => {
    const fixture = await completionFixture();
    await completeRun(fixture.ctx);
    expect(ciphertextKeyId(fixture.row.memoryCapturePayload)).toBeTruthy();
    await clearThread(fixture.prisma as unknown as PrismaClient, {
      spaceId: owner.spaceId,
      botId: owner.botId,
      threadId: fixture.row.threadId,
    });
    expect(fixture.row.memoryCapturePayload).toBeNull();
    expect(fixture.row.memoryCaptureDueAt).toBeNull();
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    expect(fixture.captureTurn).not.toHaveBeenCalled();
  });

  it("does not send an already-read snapshot when clear wins during provider resolution", async () => {
    const fixture = await completionFixture();
    await completeRun(fixture.ctx);
    const resolve = fixture.deps.memoryProviders.resolveTurnMemory;
    vi.mocked(resolve).mockImplementationOnce(async () => {
      await clearThread(fixture.prisma as unknown as PrismaClient, {
        spaceId: owner.spaceId,
        botId: owner.botId,
        threadId: fixture.row.threadId,
      });
      return resolve(owner.spaceId);
    });
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    expect(fixture.captureTurn).not.toHaveBeenCalled();
    expect(fixture.row.memoryCapturePayload).toBeNull();
  });

  it("does not send a snapshot cleared while claiming the connection lease", async () => {
    const fixture = await completionFixture();
    await completeRun(fixture.ctx);
    const resolve = fixture.deps.memoryProviders.resolveTurnMemory;
    vi.mocked(resolve).mockImplementationOnce(async () => {
      const resolved = await resolve(owner.spaceId);
      if (resolved.kind !== "configured") throw new Error("Expected fixture lifecycle");
      return {
        ...resolved,
        captureConnection: async (send) => {
          await clearThread(fixture.prisma as unknown as PrismaClient, {
            spaceId: owner.spaceId,
            botId: owner.botId,
            threadId: fixture.row.threadId,
          });
          return send();
        },
      };
    });
    await captureFinishedTurn(fixture.deps, fixture.row.id);
    expect(fixture.captureTurn).not.toHaveBeenCalled();
    expect(fixture.row.memoryCapturePayload).toBeNull();
  });

  it.each(["replace", "delete"] as const)(
    "fails closed for legacy evidence after %s without consulting today's vault",
    async (operation) => {
      const fixture = await completionFixture();
      Object.assign(fixture.row, {
        status: "completed",
        completedAt: new Date(),
        memoryCaptureDueAt: new Date(),
        memoryCaptureScope: "isolated",
        memoryCaptureTarget: "fixture-target",
      });
      fixture.botMessages.push({
        blocks: [{ kind: "text", text: "Completed safely." }],
        clientNonce: null,
      });
      await fixture.rotate(operation);
      fixture.message.findMany.mockClear();
      const load = vi.spyOn(fixture.secretStore, "load");
      await captureFinishedTurn(fixture.deps, fixture.row.id);
      expect(fixture.captureTurn).not.toHaveBeenCalled();
      expect(fixture.message.findFirst).not.toHaveBeenCalled();
      expect(fixture.message.findMany).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(fixture.row.memoryCapturePayload).toBeNull();
      expect(fixture.row.memoryCapturedAt).toBeInstanceOf(Date);
    },
  );

  it.each(["replace", "delete"] as const)(
    "Q1: never sends the old user-source password after %s before first delivery",
    async (operation) => {
      const fixture = await completionFixture();
      expect(fixture.botMessages).toHaveLength(0);
      await completeRun(fixture.ctx);
      const snapshot = fixture.row.memoryCapturePayload;
      await fixture.rotate(operation);
      await captureFinishedTurn(fixture.deps, fixture.row.id);
      expect(fixture.captureTurn).toHaveBeenCalledOnce();
      const capture = fixture.captureTurn.mock.calls[0]![0];
      expect(JSON.stringify(capture)).not.toContain(marker);
      expect(capture.query).toContain("[redacted]");
      expect(capture.answer).toBe("Completed without echoing a credential.");
      expect(capture.sequence).toBe(7);
      expect(capture.completedAt).toBe(fixture.row.completedAt!.toISOString());
      expect(capture.sourceMemoryIds).toEqual(["memory-1"]);
      const keyId = ciphertextKeyId(snapshot);
      expect(keyId).toBeTruthy();
      const opened = decryptText(
        await fixture.ring.byId(keyId!),
        {
          table: "runs",
          column: "memoryCapturePayload",
          rowId: fixture.row.id,
          owner: fixture.row.threadId,
        },
        snapshot as string,
      );
      expect(JSON.parse(opened)).toEqual(capture);
      expect(opened).not.toContain(marker);
      expect(fixture.row.memoryCapturePayload).toBeNull();
    },
  );
});
