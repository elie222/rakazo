import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deferred } from "@rakazo/core/test-async";
import { createDb, createThreadEvents, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { placeholderObservation } from "../../computers/screens/computer-support.js";
import { LocalArtifactStore } from "../../storage/artifacts.js";
import type { RunContext } from "../assembly/run-context.js";
import { withRunLease } from "../assembly/run-messages.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { completeEffect } from "../lifecycle/run-effects.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("attach_file (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const id = `attach-file-${randomUUID()}`;
  const spaceId = `${id}-space`;
  const userId = `${id}-user`;
  const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const organizationId = `${id}-org`;
  let root = "";
  let run: { id: string; spaceId: string; userId: string; threadId: string; botId: string };
  let bytes = new Uint8Array();
  const observe = vi.fn(async () => placeholderObservation("routine screenshot"));

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-attach-file-"));
    run = await fixture(async () => {
      await prisma.user.create({
        data: { id: userId, name: "Attach tester", email: `${id}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Attach tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Attach tests" } });
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: "Attacher",
          color: "ink",
          thread: { create: { spaceId, userId } },
        },
        include: { thread: true },
      });
      const threadId = bot.thread!.id;
      const task = await prisma.task.create({
        data: { spaceId, userId, botId: bot.id, threadId, prompt: "Attach", status: "running" },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user_message",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        select: { id: true, spaceId: true, userId: true, threadId: true, botId: true },
      });
    });
  });

  afterAll(async () => {
    try {
      // The organization cascades to the space, bot, thread, run, artifacts, messages and
      // chat group; the user owns nothing else.
      await fixture(async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await prisma.$disconnect();
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  const attach = async (
    args: { path: string } | { screenshot: true },
    lease: { owner: string; fence: number },
    client: typeof prisma = prisma,
  ) => {
    const deps = withRunLease(
      {
        prisma: client,
        artifacts: new LocalArtifactStore(root),
        sandbox: {
          readFile: async () => bytes,
          observe,
        },
        events: createThreadEvents(prisma),
      } as unknown as ExecutorDeps,
      run.id,
      lease,
    );
    const ctx = {
      deps,
      run: { ...run, trigger: "screenshot" in args ? "routine" : "user_message" },
      runId: run.id,
      bot: { id: run.botId },
      thread: { id: run.threadId, groupId: null },
      context: {
        operationId: `op-${randomUUID()}`,
        traceId: "trace",
        spaceId,
        userId,
        botId: run.botId,
        runId: run.id,
        signal: new AbortController().signal,
      },
      source: {},
      secrets: [],
      computer: {
        mode: "personal",
        stored: { id: "computer" },
        get: async () => ({ id: "computer", botId: run.botId, kind: "fake" }),
        checkpoint: { markDirty() {} },
      },
      state: { screen: { turn: { mustLook: false } } },
    } as unknown as RunContext;
    const effect =
      "screenshot" in args
        ? await fixture(() =>
            prisma.externalEffect.create({
              data: {
                spaceId,
                runId: run.id,
                kind: "attach_file",
                idempotencyKey: randomUUID(),
                request: args,
                status: "intended",
              },
            }),
          )
        : undefined;
    const persistEffectResult = async (result: unknown, tx = client) =>
      effect ? completeEffect(tx, effect.id, "intended", result) : true;
    const call = {
      name: "attach_file",
      args,
      executionId: `call-${randomUUID()}`,
      applied: effect && { effect },
      persistEffectResult,
      finish: async (result: unknown) => {
        await persistEffectResult(result);
        return result;
      },
    } as unknown as ToolCall;
    return runAsSystem("agent run tool call", () => fileTools.attach_file!(ctx, call));
  };
  const state = () =>
    fixture(async () => ({
      artifacts: await prisma.artifact.findMany({
        where: { runId: run.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, hash: true },
      }),
      messages: await prisma.message.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
        select: { blocks: true },
      }),
      stored: await readdir(path.join(root, "artifacts", spaceId)).catch(() => []),
    }));

  it("leaves nothing behind when the message cannot be written, then posts on retry", async () => {
    bytes = new TextEncoder().encode("first image");
    const failed = await attach({ path: "shots/first.png" }, { owner: "worker-0", fence: 0 });
    expect(failed).toMatchObject({ error: expect.stringContaining("history") });
    expect(await state()).toEqual({ artifacts: [], messages: [], stored: [] });

    const posted = (await attach({ path: "shots/first.png" }, { owner: "worker-1", fence: 1 })) as {
      artifactId: string;
    };
    const after = await state();
    expect(after.artifacts).toHaveLength(1);
    expect(after.stored).toHaveLength(1);
    expect(after.messages.map((message) => message.blocks)).toEqual([
      [expect.objectContaining({ kind: "image", artifactId: posted.artifactId })],
    ]);
  });

  it("posts a fresh screen image as a routine's chat attachment", async () => {
    const before = await state();
    const posted = await attach({ screenshot: true }, { owner: "worker-1", fence: 1 });
    expect(posted).toMatchObject({ ok: true, artifactId: expect.any(String) });
    const after = await state();
    expect(after.messages.slice(before.messages.length).map((message) => message.blocks)).toEqual([
      [
        expect.objectContaining({
          kind: "image",
          artifactId: (posted as { artifactId: string }).artifactId,
          mimeType: "image/png",
        }),
      ],
    ]);
    const effect = await fixture(() =>
      prisma.externalEffect.findFirst({ where: { runId: run.id, kind: "attach_file" } }),
    );
    expect(effect).toMatchObject({ status: "completed", result: posted });
  });

  it("settles a failed capture without posting an attachment", async () => {
    observe.mockRejectedValueOnce(new Error("capture unavailable"));
    const before = await state();
    const result = await attach({ screenshot: true }, { owner: "worker-1", fence: 1 });
    expect(result).toEqual({ error: "capture unavailable" });
    expect(await state()).toEqual(before);
    const effect = await fixture(() =>
      prisma.externalEffect.findFirst({
        where: {
          runId: run.id,
          kind: "attach_file",
          result: { path: ["error"], equals: "capture unavailable" },
        },
      }),
    );
    expect(effect?.status).toBe("completed");
  });

  it("returns the completed result when another attempt settles the attachment first", async () => {
    const started = deferred();
    const captured = deferred<Awaited<ReturnType<typeof observe>>>();
    observe.mockImplementationOnce(() => {
      started.resolve();
      return captured.promise;
    });
    const before = await state();
    const pending = attach({ screenshot: true }, { owner: "worker-1", fence: 1 });
    await started.promise;
    const posted = { ok: true, artifactId: "winning-attachment" };
    try {
      await fixture(async () => {
        const changed = await prisma.externalEffect.updateMany({
          where: { runId: run.id, kind: "attach_file", status: "intended" },
          data: { status: "completed", result: posted },
        });
        expect(changed.count).toBe(1);
      });
    } finally {
      captured.resolve(placeholderObservation("routine screenshot"));
    }
    await expect(pending).resolves.toEqual(posted);
    expect(await state()).toEqual(before);
  });

  it("retries the artifact transaction after a deadlock and posts once", async () => {
    bytes = new TextEncoder().encode("second image");
    // Postgres aborts a deadlock victim with 40P01. Raise one from inside the first
    // transaction, before any row is written, so it reaches the retry through the driver
    // exactly as a real victim's abort would.
    let attempts = 0;
    const flaky = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          target.$transaction(async (tx) => {
            attempts += 1;
            if (attempts === 1) {
              await tx.$executeRawUnsafe(
                "DO $$ BEGIN RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01'; END $$",
              );
            }
            return fn(tx);
          }, options as never);
      },
    });

    const before = await state();
    const posted = (await attach(
      { path: "shots/second.png" },
      { owner: "worker-1", fence: 1 },
      flaky,
    )) as {
      artifactId: string;
    };
    expect(posted).toMatchObject({ artifactId: expect.any(String) });
    expect(attempts).toBe(2);
    const after = await state();
    expect(after.artifacts).toHaveLength(before.artifacts.length + 1);
    expect(after.stored).toHaveLength(before.stored.length + 1);
    expect(after.messages.slice(before.messages.length).map((message) => message.blocks)).toEqual([
      [expect.objectContaining({ kind: "image", artifactId: posted.artifactId })],
    ]);
  });

  it("posts behind a thread read longer than the default transaction budget", async () => {
    bytes = new TextEncoder().encode("third image");
    // A thread snapshot holds the thread row FOR SHARE for up to 15 s, and the message write
    // inside the artifact transaction waits for it. The timed hold starts only once the
    // attach is observed queued on the holder, so connection checkout cannot shorten what it
    // waits, and it is held past Prisma's five-second default: the attach only survives on
    // the thread-lock budget.
    const holdMs = 6_000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lockTaken = deferred<string>();
    const opened = deferred();
    const hold = fixture(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR SHARE`;
          const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
          lockTaken.resolve(rows[0]?.xactId ?? "");
          await opened.promise;
        },
        { timeout: 30_000 },
      ),
    );
    const xactId = await lockTaken.promise;
    const before = await state();
    const probe = await fixture(() => pool.connect());
    let posted: { artifactId: string };
    try {
      const attaching = attach({ path: "shots/third.png" }, { owner: "worker-1", fence: 1 });
      // Backends waiting on the holder's transaction: the attach, blocked on the thread row.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const result = await probe.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        if ((result.rows[0].waiting as number) > 0) break;
        if (Date.now() >= deadline)
          throw new Error("the attach did not block on the held thread row");
        await sleep(20);
      }
      // The blocked write sits in Postgres until the row is released; on the default budget
      // Prisma reports the expiry then, and the attach returns an error instead of posting.
      await sleep(holdMs);
      opened.resolve();
      posted = (await attaching) as { artifactId: string };
      expect(posted).toMatchObject({ artifactId: expect.any(String) });
    } finally {
      opened.resolve();
      probe.release();
      await hold.catch(() => undefined);
    }
    const after = await state();
    expect(after.artifacts).toHaveLength(before.artifacts.length + 1);
    expect(after.stored).toHaveLength(before.stored.length + 1);
    expect(after.messages.slice(before.messages.length).map((message) => message.blocks)).toEqual([
      [expect.objectContaining({ kind: "image", artifactId: posted.artifactId })],
    ]);
  }, 30_000);
});
