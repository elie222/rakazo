import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../database/client.js";
import { asSystem, runAsTenant } from "../database/row-security.js";
import { LocalKeyProvider } from "../encryption/content-keys.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { clearThread, finalizeRun } from "./events.js";
import { createThreadMessage } from "./messages.js";
import {
  nativeDmProfileRevision,
  prepareNativeDmSession,
  pruneNativeDmSessions,
} from "./native-dm-session.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
const master = { id: "native-dm-fixture", key: randomBytes(32) };
const grant = "a".repeat(64);
const snapshot = {
  scope: "b".repeat(64),
  sessionId: "7089f7dd-a15a-43bf-ae0b-563720ee5973",
  transcript: "fixture native transcript marker",
  signature: "c".repeat(64),
};

describePostgres("native DM snapshots (PostgreSQL)", () => {
  const clients: ReturnType<typeof createDb>[] = [];
  function client(encryptContent = true, keyProvider = new LocalKeyProvider([master])) {
    const db = createDb(url!, { encryptContent, keyProvider });
    clients.push(db);
    return db;
  }
  const db = client();
  const sys = asSystem(db.prisma);
  let ids: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let thread2: { id: string; botId: string };
  let credentialId: string;
  let profile: string;
  let otherProfile: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const model = { modelProvider: "fixture", modelId: "fixture-model" };

  beforeAll(async () => {
    ids = await provisionMessagingIdentity(sys, { provider: "sendblue", address });
    const { userId, spaceId } = ids;
    const credential = await sys.userModelCredential.create({
      data: { userId, provider: model.modelProvider, label: "Fixture", secretId: randomUUID() },
    });
    credentialId = credential.id;
    const bot = await sys.bot.update({
      where: { id: ids.botId },
      data: { ...model, modelCredentialId: credentialId },
    });
    profile = nativeDmProfileRevision(bot);
    const other = await sys.bot.create({
      data: {
        userId,
        spaceId,
        name: "Other",
        color: "ink",
        ...model,
        modelCredentialId: credentialId,
      },
    });
    otherProfile = nativeDmProfileRevision(other);
    const thread = await sys.thread.create({ data: { userId, spaceId, botId: other.id } });
    thread2 = { id: thread.id, botId: other.id };
  });

  afterAll(async () => {
    if (ids) {
      await sys.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await sys.organization.deleteMany({ where: { id: ids.spaceId } });
      await sys.user.deleteMany({ where: { id: ids.userId } });
    }
    for (const c of clients) {
      await c.prisma.$disconnect();
      await c.pool.end();
    }
  });

  async function start(thread = { id: ids.threadId, botId: ids.botId }, authenticated = true) {
    const { spaceId, userId } = ids;
    const { id: threadId, botId } = thread;
    const base = { spaceId, threadId, botId, userId };
    const message = await createThreadMessage(sys, {
      threadId,
      authorUserId: userId,
      role: "user",
      blocks: [{ kind: "text", text: "hello" }],
    });
    const task = await sys.task.create({ data: { ...base, prompt: "hello", status: "running" } });
    const run = await sys.run.create({
      data: {
        ...base,
        taskId: task.id,
        status: "running",
        trigger: "user",
        modelPinned: true,
        primaryRuntime: "fixture-native",
        ...model,
        modelCredentialId: credentialId,
        nativeDmResumeGrant: authenticated ? grant : null,
        sourceMessageId: message.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
      },
    });
    await sys.message.update({ where: { id: message.id }, data: { runId: run.id } });
    const attempt = await sys.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return {
      ...base,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "fixture-worker",
      leaseFence: 1,
    };
  }

  const prepare = (
    turn: Awaited<ReturnType<typeof start>>,
    revision = profile,
    prisma = db.prisma,
    activeGrant = grant,
  ) => runAsTenant(ids, () => prepareNativeDmSession(prisma, turn, activeGrant, revision));
  async function finish(
    turn: Awaited<ReturnType<typeof start>>,
    candidate?: NonNullable<Awaited<ReturnType<typeof prepare>>>,
  ) {
    return runAsTenant(ids, () =>
      finalizeRun(db.prisma, {
        ...turn,
        outcome: "completed",
        blocks: [{ kind: "text", text: "done" }],
        nativeDmSession: candidate?.seal(snapshot),
      }),
    );
  }
  const read = (threadId = ids.threadId) => sys.nativeDmSession.findUnique({ where: { threadId } });
  const clear = () => runAsTenant(ids, () => clearThread(db.prisma, ids));

  it("seals the latest reply, survives a new client, and never crosses an intervening turn", async () => {
    const first = await start();
    expect(await prepare(first, profile, client(false).prisma)).toBeUndefined();
    expect(await prepare(first, profile, db.prisma, "e".repeat(64))).toBeUndefined();
    expect(await read()).toBeNull();
    const started = await prepare(first);
    expect(started?.previous).toBeUndefined();
    expect(started).toBeDefined();
    await finish(first, started);
    expect((await read())?.ciphertext).toMatch(/^rkz1:/);
    expect((await read())?.ciphertext).not.toContain(snapshot.transcript);
    await expect(
      runAsTenant({ ...ids, userId: "another-member" }, () =>
        db.prisma.nativeDmSession.findMany({ where: { threadId: ids.threadId } }),
      ),
    ).resolves.toEqual([]);
    const second = await start();
    expect((await prepare(second, profile, client().prisma))?.previous).toEqual(snapshot);
    expect(
      await prepare(
        second,
        profile,
        client(true, new LocalKeyProvider([{ id: "other-key", key: randomBytes(32) }])).prisma,
      ),
    ).toBeUndefined();
    await finish(second, await prepare(second));
    const api = await start(undefined, false);
    expect(await prepare(api)).toBeUndefined();
    await finish(api);
    const afterApi = await start();
    expect((await prepare(afterApi))?.previous).toBeUndefined();
    await finish(afterApi);
    await clear();
  });

  it("erases on clear in both completion orders without touching another bot", async () => {
    const other = await start(thread2);
    await finish(other, await prepare(other, otherProfile));
    const first = await start();
    await finish(first, await prepare(first));
    expect(await read()).not.toBeNull();
    await clear();
    expect(await read()).toBeNull();
    const late = await start();
    const candidate = await prepare(late);
    expect(candidate?.previous).toBeUndefined();
    expect(candidate).toBeDefined();
    await clear();
    expect(await finish(late, candidate)).toBe(false);
    expect(await read()).toBeNull();
    expect(await read(thread2.id)).not.toBeNull();
  });

  it("invalidates a candidate on connection rotation and prunes expired snapshots", async () => {
    const turn = await start();
    const staged = await prepare(turn);
    expect(staged).toBeDefined();
    await sys.userModelCredential.update({
      where: { id: credentialId },
      data: { secretId: randomUUID() },
    });
    await finish(turn, staged);
    expect(await read()).toBeNull();
    await sys.nativeDmSession.update({
      where: { threadId: thread2.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await pruneNativeDmSessions(db.prisma, new Date())).toBeGreaterThanOrEqual(1);
    expect(await read(thread2.id)).toBeNull();
  });
});
