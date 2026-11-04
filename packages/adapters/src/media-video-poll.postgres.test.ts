import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, clearThread, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "./artifact-store-factory.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import {
  MEDIA_POLL_DEADLINE_MS,
  mediaDelivery,
  pollMediaVideo,
  reconcileMediaVideos,
} from "./media-video-poll.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/** A provider whose remote job finishes, fails or errors when the test says so. */
class ScriptedVideoProvider extends FakeMediaGenerationProvider {
  remote: "running" | "completed" | "failed" | "error" = "running";
  submissions = 0;
  polls = 0;
  override async generateVideo(): Promise<MediaVideoJob> {
    this.submissions++;
    return { id: `remote-${this.submissions}`, status: "queued", progress: 0 };
  }
  override async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    this.polls++;
    if (this.remote === "error") throw new MediaGenerationError("provider_failure");
    if (this.remote === "completed") return super.pollVideo(id, context);
    return { id, status: this.remote };
  }
}

describePostgres("background video delivery (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-media-poll-"));
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function owner() {
    const id = randomUUID();
    users.push(id);
    return runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Video test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Video test", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Video test", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Video test", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Make a video",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
      return { id, bot, thread, run };
    });
  }

  async function setup() {
    const user = await owner();
    const media = new ScriptedVideoProvider();
    const enqueued: BackgroundJob[] = [];
    // Each "process" gets fresh dependencies; nothing but the database survives a restart.
    const process = () => {
      const jobs: JobPublisher = {
        enqueue: async (job) => {
          enqueued.push(job);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      };
      return {
        prisma,
        jobs,
        events: { notify: vi.fn(async () => undefined) },
        artifacts: createArtifactStore(dataDir, prisma, {}),
        mediaGeneration: media,
      };
    };
    const tenant = { spaceId: user.id, userId: user.id };
    const run = {
      id: user.run.id,
      threadId: user.thread.id,
      botId: user.bot.id,
      userId: user.id,
      spaceId: user.id,
    };
    const submit = async () => {
      const deps = process();
      const result = await runAsTenant(tenant, () =>
        generateMediaFromTool({
          name: "generate_video",
          args: { prompt: "a lighthouse at dusk" },
          executionId: randomUUID(),
          provider: media,
          prisma,
          context: {
            operationId: randomUUID(),
            traceId: "test",
            spaceId: user.id,
            userId: user.id,
            botId: user.bot.id,
            signal: new AbortController().signal,
          },
          run,
          threadGeneration: 0,
          ...mediaDelivery(deps, run, { providerId: media.id, operationId: "submit" }),
        }),
      );
      if (!result || !("jobId" in result) || !result.jobId) throw new Error("Submission failed");
      // The turn ends with the video still queued.
      await runAsSystem("test fixture", () =>
        prisma.run.update({ where: { id: user.run.id }, data: { status: "completed" } }),
      );
      return result.jobId;
    };
    const poll = (jobId: string) => runAsTenant(tenant, () => pollMediaVideo(process(), { jobId }));
    const reconcile = () => runAsSystem("reconcile", () => reconcileMediaVideos(process()));
    const job = (jobId: string) =>
      asSystem(prisma).externalEffect.findUniqueOrThrow({ where: { id: jobId } });
    const messages = (threadId = user.thread.id) =>
      asSystem(prisma).message.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
    const wakes = () =>
      asSystem(prisma).run.findMany({
        where: { threadId: user.thread.id, trigger: "media" },
        include: { task: true },
      });
    return { user, media, enqueued, submit, poll, reconcile, job, messages, wakes, tenant };
  }

  it("posts a video finished after a restart to the chat that asked, once", async () => {
    const h = await setup();
    const other = await owner();
    const jobId = await h.submit();
    expect(h.media.submissions).toBe(1);
    // Restart: the scheduled poll is lost, and recovery finds the job from the database alone.
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.enqueued).toEqual([
      expect.objectContaining({ name: "media.poll", payload: { jobId }, keepExisting: true }),
    ]);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(h.enqueued.at(-1)).toMatchObject({ name: "media.poll", payload: { jobId } });

    h.media.remote = "completed";
    await Promise.all([h.poll(jobId), h.poll(jobId)]);
    await h.poll(jobId);
    await h.reconcile();

    expect(h.media.submissions).toBe(1);
    expect((await h.job(jobId)).status).toBe("media_completed");
    const posted = await h.messages();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ role: "bot", botId: h.user.bot.id, runId: h.user.run.id });
    expect(posted[0]!.blocks).toEqual([expect.objectContaining({ mimeType: "video/mp4" })]);
    expect(await h.messages(other.thread.id)).toHaveLength(0);
    const wakes = await h.wakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.task.prompt).toContain("finished");
    // Recovery leaves a finished job alone.
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.enqueued).toEqual([]);
  });

  it("reports a failed video to the bot instead of leaving the chat empty", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "failed";
    await h.poll(jobId);
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.messages()).toHaveLength(0);
    const wakes = await h.wakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.task.prompt).toContain("failed");
    expect(h.media.submissions).toBe(1);
  });

  it("keeps checking through provider errors without resubmitting", async () => {
    const h = await setup();
    const jobId = await h.submit();
    h.media.remote = "error";
    h.enqueued.length = 0;
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_pending");
    expect(h.enqueued).toEqual([expect.objectContaining({ name: "media.poll" })]);
    expect(await h.wakes()).toHaveLength(0);
    h.media.remote = "completed";
    await h.poll(jobId);
    expect((await h.job(jobId)).status).toBe("media_completed");
    expect(h.media.submissions).toBe(1);
  });

  it("marks a video failed once it outlives the deadline, without asking the provider", async () => {
    const h = await setup();
    const jobId = await h.submit();
    await runAsSystem("test fixture", () =>
      prisma.externalEffect.update({
        where: { id: jobId },
        data: { createdAt: new Date(Date.now() - MEDIA_POLL_DEADLINE_MS - 60_000) },
      }),
    );
    const polls = h.media.polls;
    await h.poll(jobId);
    expect(h.media.polls).toBe(polls);
    expect((await h.job(jobId)).status).toBe("media_failed");
    expect(await h.wakes()).toHaveLength(1);
  });

  it("posts nothing into a chat cleared after the video was submitted", async () => {
    const h = await setup();
    const jobId = await h.submit();
    await runAsTenant(h.tenant, () =>
      clearThread(prisma, {
        spaceId: h.user.id,
        botId: h.user.bot.id,
        threadId: h.user.thread.id,
      }),
    );
    h.media.remote = "completed";
    await h.poll(jobId);
    expect(await h.messages()).toHaveLength(0);
    expect(await h.wakes()).toHaveLength(0);
    expect(h.media.polls).toBe(0);
    h.enqueued.length = 0;
    await h.reconcile();
    expect(h.enqueued).toEqual([]);
  });
});
