import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  HIDDEN_ARTIFACT_MIME_TYPES,
  provisionMessagingIdentity,
  runAsSystem,
  withResolvedArtifactVersion,
} from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";
import { createOriginalFilesPruner } from "./prune-original-files.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

const DAY = 24 * 60 * 60_000;
// Long before any other test's rows, so a pass here only ever reaches this file's files.
const NOW = new Date("1991-01-01T00:00:00Z");
const OLD = new Date(NOW.getTime() - 40 * DAY);
const RECENT = new Date(NOW.getTime() - DAY);
const MCP_APP = HIDDEN_ARTIFACT_MIME_TYPES.find((type) => type.startsWith("text/html"))!;
const STEP_SCREENSHOT = HIDDEN_ARTIFACT_MIME_TYPES.find((type) => type.startsWith("image/"))!;

describePostgres("createOriginalFilesPruner (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string };
  let botId: string;
  let root: string;
  let store: LocalArtifactStore;
  const address = `original-files-${randomUUID()}@rakazo.test`;
  const context = () =>
    ({
      operationId: "test",
      traceId: "test",
      spaceId: identity.spaceId,
      userId: identity.userId,
      signal: AbortSignal.timeout(30_000),
    }) satisfies AdapterContext;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("original files fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    botId = (
      await system.bot.create({
        data: { spaceId: identity.spaceId, userId: identity.userId, name: "Dana", color: "ink" },
      })
    ).id;
    root = await mkdtemp(path.join(tmpdir(), "rakazo-original-files-pg-"));
    store = new LocalArtifactStore(root);
  });

  afterEach(async () => {
    await system.artifact.deleteMany({ where: { spaceId: identity.spaceId } });
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (root) await rm(root, { recursive: true, force: true });
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  /** A stored file with its blob: a version of `rootArtifactId` when given, else a root. */
  async function file(input: {
    at: Date;
    runId?: string;
    mimeType?: string;
    rootArtifactId?: string;
    version?: number;
    botId?: string;
  }) {
    const mimeType = input.mimeType ?? "application/pdf";
    const blob = await store.put(
      { name: "report.pdf", mimeType, bytes: new Uint8Array([1, 2, 3]) },
      context(),
    );
    return system.artifact.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        runId: input.runId ?? null,
        botId: input.botId ?? null,
        name: "report.pdf",
        mimeType,
        size: 3,
        hash: blob.hash,
        storageKey: blob.id,
        createdAt: input.at,
        rootArtifactId: input.rootArtifactId ?? null,
        version: input.version ?? 1,
      },
    });
  }

  const blobExists = (storageKey: string) =>
    stat(path.join(root, "artifacts", identity.spaceId, storageKey)).then(
      () => true,
      () => false,
    );
  const rowExists = async (id: string) =>
    (await system.artifact.findUnique({ where: { id } })) !== null;

  function pruner(
    switches: { received: boolean; created: boolean },
    options: { artifacts?: LocalArtifactStore; now?: () => Date } = {},
  ) {
    const prune = createOriginalFilesPruner({
      prisma: db.prisma,
      artifacts: options.artifacts ?? store,
      settings: { ...switches, maxAgeMs: 31 * DAY, intervalMs: DAY },
      now: options.now ?? (() => NOW),
    });
    if (!prune) throw new Error("expected a pruner");
    return prune;
  }

  function captureLogs() {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));
    const removed = () =>
      sink.events
        .filter((event) => event.message === "files-cleanup.originals.removed")
        .map((event) => event["files.originals.removed"]);
    const kept = () =>
      sink.events
        .filter((event) => event.message === "files-cleanup.originals.kept")
        .map((event) => event["files.originals.kept"]);
    return { sink, removed, kept };
  }

  it("deletes a 40-day-old received file, its row and its blob, when received is on", async () => {
    const { removed } = captureLogs();
    const received = await file({ at: OLD });

    await pruner({ received: true, created: false })();

    expect(await rowExists(received.id)).toBe(false);
    expect(await blobExists(received.storageKey)).toBe(false);
    expect(removed()).toEqual([1]);
  });

  it("keeps a 40-day-old received file when only created is on", async () => {
    const received = await file({ at: OLD });

    await pruner({ received: false, created: true })();

    expect(await rowExists(received.id)).toBe(true);
    expect(await blobExists(received.storageKey)).toBe(true);
  });

  it("deletes a 40-day-old file a bot made when created is on, and keeps it with only received", async () => {
    const created = await file({ at: OLD, runId: "run-1" });

    await pruner({ received: true, created: false })();
    expect(await rowExists(created.id)).toBe(true);

    await pruner({ received: false, created: true })();
    expect(await rowExists(created.id)).toBe(false);
    expect(await blobExists(created.storageKey)).toBe(false);
  });

  it("keeps a fresh file and a fresh family with both switches on", async () => {
    const fresh = await file({ at: RECENT });
    const oldRoot = await file({ at: OLD });
    const version = await file({
      at: RECENT,
      runId: "run-1",
      rootArtifactId: oldRoot.id,
      version: 2,
    });

    await pruner({ received: true, created: true })();

    expect(await rowExists(fresh.id)).toBe(true);
    expect(await rowExists(oldRoot.id)).toBe(true);
    expect(await rowExists(version.id)).toBe(true);
  });

  it("keeps a received root with a 1-day-old bot version, even with only received on", async () => {
    const receivedRoot = await file({ at: OLD });
    const version = await file({
      at: RECENT,
      runId: "run-1",
      rootArtifactId: receivedRoot.id,
      version: 2,
    });

    await pruner({ received: true, created: false })();

    expect(await rowExists(receivedRoot.id)).toBe(true);
    expect(await rowExists(version.id)).toBe(true);
    expect(await blobExists(receivedRoot.storageKey)).toBe(true);
  });

  it("counts a family by its newest version: an old received root with an old bot version is created", async () => {
    const receivedRoot = await file({ at: new Date(OLD.getTime() - 5 * DAY) });
    const version = await file({
      at: OLD,
      runId: "run-1",
      rootArtifactId: receivedRoot.id,
      version: 2,
    });

    await pruner({ received: true, created: false })();
    expect(await rowExists(receivedRoot.id)).toBe(true);
    expect(await rowExists(version.id)).toBe(true);

    await pruner({ received: false, created: true })();
    // The whole family goes: the version and the root, each with its blob.
    expect(await rowExists(receivedRoot.id)).toBe(false);
    expect(await rowExists(version.id)).toBe(false);
    expect(await blobExists(receivedRoot.storageKey)).toBe(false);
    expect(await blobExists(version.storageKey)).toBe(false);
  });

  it("counts a created root with a newer received version as received", async () => {
    const createdRoot = await file({ at: new Date(OLD.getTime() - 5 * DAY), runId: "run-1" });
    const version = await file({ at: OLD, rootArtifactId: createdRoot.id, version: 2 });

    await pruner({ received: false, created: true })();
    expect(await rowExists(createdRoot.id)).toBe(true);

    await pruner({ received: true, created: false })();
    expect(await rowExists(createdRoot.id)).toBe(false);
    expect(await rowExists(version.id)).toBe(false);
  });

  it("keeps a 40-day-old step screenshot and MCP app file with both switches on", async () => {
    const screenshot = await file({ at: OLD, runId: "run-1", mimeType: STEP_SCREENSHOT });
    const app = await file({ at: OLD, runId: "run-1", mimeType: MCP_APP });
    const receivedScreenshot = await file({ at: OLD, mimeType: STEP_SCREENSHOT });

    await pruner({ received: true, created: true })();

    expect(await rowExists(screenshot.id)).toBe(true);
    expect(await rowExists(app.id)).toBe(true);
    expect(await rowExists(receivedScreenshot.id)).toBe(true);
    expect(await blobExists(screenshot.storageKey)).toBe(true);
    expect(await blobExists(app.storageKey)).toBe(true);
  });

  it("cleans 250 old files 200 in the first pass, oldest first, and 50 in the next", async () => {
    const { removed } = captureLogs();
    const ids = Array.from({ length: 250 }, () => randomUUID());
    await system.artifact.createMany({
      data: ids.map((id, index) => ({
        id,
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 3,
        hash: "3",
        storageKey: `missing-${id}`,
        // The first is the oldest.
        createdAt: new Date(OLD.getTime() - (250 - index) * 60_000),
      })),
    });
    let now = NOW;
    const prune = pruner({ received: true, created: true }, { now: () => now });
    const left = () => system.artifact.findMany({ where: { spaceId: identity.spaceId } });

    await prune();
    const after = await left();
    expect(after).toHaveLength(50);
    expect(new Set(after.map((row) => row.id))).toEqual(new Set(ids.slice(200)));

    // Within the interval nothing more goes.
    now = new Date(NOW.getTime() + DAY - 1);
    await prune();
    expect(await left()).toHaveLength(50);

    now = new Date(NOW.getTime() + DAY);
    await prune();
    expect(await left()).toHaveLength(0);
    expect(removed()).toEqual([200, 50]);
  });

  it("carries on past a family deleted by hand mid-pass and one that cannot be deleted", async () => {
    const { sink, removed } = captureLogs();
    const first = await file({ at: new Date(OLD.getTime() - 3 * DAY) });
    const second = await file({ at: new Date(OLD.getTime() - 2 * DAY) });
    const secondVersion = await file({ at: OLD, rootArtifactId: second.id, version: 2 });
    const broken = await file({ at: new Date(OLD.getTime() - DAY) });
    const last = await file({ at: OLD });
    const artifacts = new LocalArtifactStore(root);
    const remove = vi.spyOn(artifacts, "remove").mockImplementation(async (key, ctx) => {
      // While the first family is going, someone deletes the second from the files screen.
      if (key === first.storageKey) {
        await system.artifact.delete({ where: { id: secondVersion.id } });
        await system.artifact.delete({ where: { id: second.id } });
      }
      if (key === broken.storageKey) {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '/data/${key}'`), {
          code: "EACCES",
        });
      }
      return store.remove(key, ctx);
    });

    await expect(pruner({ received: true, created: false }, { artifacts })()).resolves.toBe(
      undefined,
    );

    expect(await rowExists(first.id)).toBe(false);
    expect(await rowExists(second.id)).toBe(false);
    // The one that failed stays for the next pass; the one after it still went.
    expect(await rowExists(broken.id)).toBe(true);
    expect(await rowExists(last.id)).toBe(false);
    expect(remove).toHaveBeenCalledWith(last.storageKey, expect.anything());
    expect(removed()).toEqual([2]);
    const logged = JSON.stringify(sink.events);
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain(broken.storageKey);
    expect(logged).not.toContain("report.pdf");
  });

  /** A same-name publish by the bot, as an upload or a run's output makes one. */
  function publish() {
    return withResolvedArtifactVersion(
      system,
      { spaceId: identity.spaceId, botId, name: "report.pdf" },
      (tx, version) =>
        tx.artifact.create({
          data: {
            spaceId: identity.spaceId,
            userId: identity.userId,
            botId,
            name: "report.pdf",
            mimeType: "application/pdf",
            size: 3,
            hash: "3",
            storageKey: `published-${randomUUID()}`,
            ...version,
          },
        }),
    );
  }

  it("keeps the root and a version published while the family is being deleted", async () => {
    const { removed, kept } = captureLogs();
    const familyRoot = await file({ at: new Date(OLD.getTime() - DAY), botId });
    const version = await file({ at: OLD, botId, rootArtifactId: familyRoot.id, version: 2 });
    let published: Awaited<ReturnType<typeof publish>> | undefined;
    const artifacts = new LocalArtifactStore(root);
    vi.spyOn(artifacts, "remove").mockImplementation(async (key, ctx) => {
      // The bot publishes a new version of the file while its old version is going.
      if (key === version.storageKey) published = await publish();
      return store.remove(key, ctx);
    });

    await pruner({ received: true, created: true }, { artifacts })();

    expect(published).toMatchObject({ rootArtifactId: familyRoot.id, version: 3 });
    expect(await rowExists(familyRoot.id)).toBe(true);
    expect(await blobExists(familyRoot.storageKey)).toBe(true);
    expect(await rowExists(published!.id)).toBe(true);
    expect(await rowExists(version.id)).toBe(false);
    expect(removed()).toEqual([]);
    expect(kept()).toEqual([1]);
  });

  it("makes a same-name publish during the root's deletion wait, then start a new family", async () => {
    const { removed } = captureLogs();
    const familyRoot = await file({ at: OLD, botId });
    let publishing: ReturnType<typeof publish> | undefined;
    const artifacts = new LocalArtifactStore(root);
    vi.spyOn(artifacts, "remove").mockImplementation(async (key, ctx) => {
      if (key === familyRoot.storageKey) {
        publishing = publish();
        // The publish queues on the name lock the deletion holds, not on the root's row.
        await vi.waitFor(async () => {
          const [waiting] = await system.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          `;
          expect(waiting?.count).toBeGreaterThan(0);
        });
      }
      return store.remove(key, ctx);
    });

    await pruner({ received: true, created: true }, { artifacts })();

    expect(await rowExists(familyRoot.id)).toBe(false);
    await expect(publishing).resolves.toMatchObject({ rootArtifactId: null, version: 1 });
    expect(removed()).toEqual([1]);
  });

  it("deletes each family under its own Space and the root's bot or id", async () => {
    const received = await file({ at: OLD });
    const remove = vi.spyOn(store, "remove");
    onTestFinished(() => remove.mockRestore());

    await pruner({ received: true, created: false })();

    expect(remove).toHaveBeenCalledWith(
      received.storageKey,
      expect.objectContaining({
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: received.id,
      }),
    );
  });
});
