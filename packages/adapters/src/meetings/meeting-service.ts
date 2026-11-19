import { createHash, randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  BackgroundJobPayloads,
  JobPublisher,
  MeetingJoinRequest,
  MeetingObservation,
  MeetingProvider,
} from "@rakazo/adapter-kit";
import { MeetingJoinRejected } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MeetingPlatformSchema, MeetingStatusSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { LeaseHeldError, runAsSystem, runAsSystemInTransaction, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { parseMeetingUrl } from "./meeting-link.js";
import { meetingTranscriptArtifact, readMeetingTurns } from "./meeting-transcript.js";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const WORK_TIMEOUT = 25_000;
const BACKUP_AFTER = WORK_TIMEOUT + 5_000;
export const MEETING_SESSION_DURATION = 2 * 60 * MINUTE + 5 * MINUTE;
export const MEETING_DAILY_LIMIT = 20;
const TRANSCRIPT_DEADLINE = 15 * MINUTE;

type Work = BackgroundJobPayloads["meeting.work"];
type JobAction = Work["action"];
type Job = Extract<BackgroundJob, { name: "meeting.work" }>;
type Session = Awaited<ReturnType<PrismaClient["meetingSession"]["findUniqueOrThrow"]>>;
const errors = {
  admission: "The bot wasn’t admitted to the meeting.",
  capture: "The bot didn’t receive permission to capture the meeting.",
  transcript: "The meeting transcript couldn’t be created.",
  join: "The bot couldn’t join the meeting.",
};

function workJob(sessionId: string, action: JobAction, availableAt = new Date()): Job {
  return {
    name: "meeting.work",
    payload: { sessionId, action },
    availableAt,
    replaceKey: workKey(sessionId, action),
    queueName: `meeting:${sessionId}`,
  };
}

function workKey(sessionId: string, action: JobAction) {
  return `meeting:${sessionId}:${action}`;
}

export class MeetingService {
  private readonly providerId: string | undefined;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      provider?: MeetingProvider;
      jobs: JobPublisher;
      events: ThreadEvents;
      spaceIds?: ReadonlySet<string>;
      buildJoin?: (input: MeetingJoinRequest) => Promise<MeetingJoinRequest> | MeetingJoinRequest;
    },
  ) {
    this.providerId = deps.provider?.describe().id;
  }

  enabled(spaceId: string) {
    return Boolean(this.deps.provider) && (this.deps.spaceIds?.has(spaceId) ?? true);
  }

  async visible(actor: Actor, botId?: string) {
    if (this.enabled(actor.spaceId)) return true;
    return Boolean(
      await this.deps.prisma.meetingSession.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId, botId, status: "ready" },
        select: { id: true },
      }),
    );
  }

  private provider(): MeetingProvider {
    if (!this.deps.provider) {
      throw new ClientError("SERVICE_UNAVAILABLE", "The meeting provider is unavailable.");
    }
    return this.deps.provider;
  }

  async list(actor: Actor, botId: string) {
    await this.bot(actor, botId);
    const rows = await this.deps.prisma.meetingSession.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        // Upcoming calendar reservations have their own view. Show only calls the
        // provider has started reporting, so skipping a reservation adds no history.
        OR: [{ scheduledFor: null }, { receivedAt: { not: null }, status: { not: "scheduled" } }],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      enabled: this.enabled(actor.spaceId),
      meetings: rows.map((row) => ({
        id: row.id,
        platform: MeetingPlatformSchema.parse(row.platform),
        status: MeetingStatusSchema.parse(row.status),
        createdAt: row.createdAt.getTime(),
        transcriptAvailable: row.status === "ready",
        error: row.error ?? undefined,
      })),
    };
  }

  async join(actor: Actor, botId: string, input: string, shareTranscript = false) {
    this.requireEnabled(actor.spaceId);
    const bot = await this.bot(actor, botId);
    const meeting = parseMeetingUrl(input);
    if (!this.provider().describe().capabilities.platforms.includes(meeting.platform)) {
      throw new ClientError("BAD_REQUEST", "This meeting platform is unavailable.");
    }
    const { prisma, jobs } = this.deps;
    const activeKey = createHash("sha256")
      .update(JSON.stringify([actor.spaceId, bot.id, meeting.platform, meeting.key]))
      .digest("hex");
    // Serialize just admission bookkeeping for this Space. The lease ends before the provider call.
    const sessionId = await withLease(
      prisma,
      `meeting-admission:${actor.spaceId}`,
      { ttlMs: 15_000 },
      async () =>
        prisma.$transaction(async (tx) => {
          const now = new Date();
          const atLimit = await runAsSystemInTransaction(
            tx,
            "count meetings against Space allowance",
            async () =>
              (await countSpaceMeetingsForDay(tx, actor.spaceId, now)) >= MEETING_DAILY_LIMIT ||
              (await countSpaceMeetingsInPastDay(tx, actor.spaceId, now)) >= MEETING_DAILY_LIMIT,
          );
          if (atLimit) {
            throw new ClientError(
              "TOO_MANY_REQUESTS",
              "This Space reached its daily meeting limit.",
            );
          }
          const id = randomUUID();
          const expiresAt = new Date(Date.now() + MEETING_SESSION_DURATION);
          await tx.meetingSession.create({
            data: {
              id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId,
              platform: meeting.platform,
              provider: this.provider().describe().id,
              meetingUrl: meeting.url,
              shareTranscript,
              status: "joining",
              activeKey,
              expiresAt,
            },
          });
          await jobs.enqueueIn(tx, workJob(id, "join", new Date(Date.now() + BACKUP_AFTER)));
          await jobs.enqueueIn(tx, workJob(id, "expire", expiresAt));
          return id;
        }),
    ).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        throw new ClientError("CONFLICT", "This bot has already been sent to that meeting.");
      }
      if (error instanceof LeaseHeldError) {
        throw new ClientError("CONFLICT", "A meeting is already being started. Try again.");
      }
      throw error;
    });
    await this.notify(actor.spaceId);
    await this.attempt(sessionId, "join");
  }

  async leave(actor: Actor, sessionId: string) {
    const row = await this.session(actor, sessionId);
    if (row.closedAt || ["ready", "ended", "processing"].includes(row.status)) return;
    if (row.provider !== this.providerId) {
      throw new ClientError("SERVICE_UNAVAILABLE", "Remove the bot from the meeting directly.");
    }
    await this.deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.meetingSession.updateMany({
        where: {
          id: sessionId,
          closedAt: null,
          status: { notIn: ["ready", "ended", "processing"] },
        },
        data: { status: "leaving" },
      });
      if (count)
        await this.deps.jobs.enqueueIn(
          tx,
          workJob(sessionId, "leave", new Date(Date.now() + BACKUP_AFTER)),
        );
    });
    await this.notify(actor.spaceId);
    await this.attempt(sessionId, "leave");
  }

  async transcript(actor: Actor, sessionId: string) {
    const row = await this.session(actor, sessionId, true);
    if (row.status !== "ready" || row.transcript === null) {
      throw new ClientError("NOT_FOUND", "The meeting transcript is unavailable.");
    }
    return {
      botId: row.botId,
      turns: readMeetingTurns(row.id, row.transcript),
      artifactAvailable:
        row.shareTranscript &&
        Boolean(
          await this.deps.prisma.artifact.findUnique({
            where: { meetingSessionId: row.id },
            select: { id: true },
          }),
        ),
    };
  }

  async shareTranscript(actor: Actor, sessionId: string) {
    const row = await this.session(actor, sessionId, true);
    if (row.status !== "ready" || row.transcript === null)
      throw new ClientError("NOT_FOUND", "The meeting transcript is unavailable.");
    const artifact = meetingTranscriptArtifact(row, readMeetingTurns(row.id, row.transcript));
    const artifactAdded = await this.deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.meetingSession.updateMany({
        where: { id: row.id, userId: actor.userId, spaceId: actor.spaceId, status: "ready" },
        data: { shareTranscript: true },
      });
      if (!count) return false;
      const saved = await tx.artifact.createMany({ data: artifact, skipDuplicates: true });
      return saved.count > 0;
    });
    await this.notify(row.spaceId, artifactAdded);
  }

  async deleteTranscript(actor: Actor, sessionId: string) {
    const row = await this.session(actor, sessionId);
    if (row.status !== "ready") return;
    const artifactDeleted = await this.deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.meetingSession.updateMany({
        where: { id: sessionId, status: "ready" },
        data: { transcript: null, status: "ended" },
      });
      if (!count) return false;
      const deleted = await tx.artifact.deleteMany({
        where: { spaceId: row.spaceId, meetingSessionId: row.id },
      });
      if (row.recordingId)
        await this.deps.jobs.enqueueIn(
          tx,
          workJob(sessionId, "cleanup", new Date(Date.now() + BACKUP_AFTER)),
        );
      return deleted.count > 0;
    });
    await this.notify(actor.spaceId, artifactDeleted);
    if (row.recordingId && row.provider === this.providerId)
      await this.attempt(sessionId, "cleanup");
  }

  parseWebhook(body: string, headers: Headers) {
    return this.provider().verifyWebhook(body, headers);
  }

  async accept(observation: MeetingObservation) {
    const { prisma } = this.deps;
    const providerId = this.provider().describe().id;
    const row = await runAsSystem("resolve signed meeting webhook", async () => {
      const known = await prisma.meetingSession.findUnique({
        where: {
          provider_externalId: { provider: providerId, externalId: observation.externalId },
        },
      });
      if (known || !observation.sessionId) return known;
      return prisma.meetingSession.findFirst({
        where: {
          id: observation.sessionId,
          provider: this.providerId,
          externalId: null,
          OR: [
            { status: { in: ["scheduled", "joining", "waiting", "leaving"] } },
            { status: "failed", requestedAt: { not: null } },
          ],
        },
      });
    });
    if (!row) return;
    const actions = await this.observe(row.id, observation);
    if (!row.closedAt && !(await this.member(row))) {
      await this.stopForDepartedMember(row);
    }
    for (const action of actions) void this.attempt(row.id, action);
  }

  async stopForDepartedMember(owner: Pick<Actor, "spaceId" | "userId">) {
    if (!this.providerId) return;
    const { prisma, jobs } = this.deps;
    const ids = await runAsSystem("stop meetings for a departed Space member", () =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.meetingSession.updateManyAndReturn({
          where: {
            spaceId: owner.spaceId,
            userId: owner.userId,
            provider: this.providerId,
            closedAt: null,
            status: { in: ["joining", "waiting", "joined", "leaving"] },
          },
          data: { status: "leaving" },
          select: { id: true },
        });
        await jobs.enqueueManyIn(
          tx,
          rows.map(({ id }) => workJob(id, "leave", new Date(Date.now() + BACKUP_AFTER))),
        );
        return rows.map(({ id }) => id);
      }),
    );
    if (ids.length) await this.notify(owner.spaceId);
    for (const id of ids) void this.attempt(id, "leave");
  }

  async recordBotRetirements(
    tx: Prisma.TransactionClient,
    bot: { spaceId: string; id: string },
  ): Promise<Job[]> {
    if (!this.providerId) return [];
    const sessions = await runAsSystemInTransaction(
      tx,
      "find provider sessions for deleted bot",
      () =>
        tx.meetingSession.findMany({
          where: {
            botId: bot.id,
            spaceId: bot.spaceId,
            provider: this.providerId,
            OR: [{ externalId: { not: null }, closedAt: null }, { recordingId: { not: null } }],
          },
          select: { id: true, provider: true, externalId: true, recordingId: true, closedAt: true },
        }),
    );
    const retirements = sessions.map((row) => {
      const job = workJob(row.id, "expire", new Date(Date.now() + BACKUP_AFTER));
      job.payload.detached = {
        provider: row.provider,
        externalId: row.closedAt ? undefined : (row.externalId ?? undefined),
        recordingId: row.recordingId ?? undefined,
      };
      return job;
    });
    if (retirements.length) await this.deps.jobs.enqueueManyIn(tx, retirements);
    return retirements;
  }

  async retireDeletedBotSessions(jobs: readonly Job[]) {
    await Promise.all(
      jobs.map(async (job) => {
        await bestEffort(
          "retire deleted bot meeting",
          (async () => {
            await this.work(job.payload);
            await this.deps.jobs.cancel(job.replaceKey!);
          })(),
        );
      }),
    );
  }

  async work(payload: Work) {
    const { prisma } = this.deps;
    return runAsSystem("perform meeting recovery work", () =>
      withLease(
        prisma,
        `meeting-work:${payload.sessionId}`,
        { ttlMs: 60_000, signal: AbortSignal.timeout(WORK_TIMEOUT) },
        async ({ signal }) => {
          const row = await prisma.meetingSession.findFirst({
            where: { id: payload.sessionId, provider: this.providerId },
            omit: { meetingUrl: false },
          });
          if (!row) {
            const retired = payload.detached;
            if (retired?.provider === this.providerId && retired) {
              const provider = this.provider();
              if (retired.externalId) {
                const current = await provider.get(retired.externalId, signal);
                if (current && !["ended", "processing"].includes(current.status ?? "")) {
                  await provider.leave(retired.externalId, signal);
                }
                if (current?.recordingId)
                  await provider.deleteRecording(current.recordingId, signal);
              }
              if (retired.recordingId) await provider.deleteRecording(retired.recordingId, signal);
            }
            return;
          }
          switch (payload.action) {
            case "join":
              return this.dispatch(row, signal);
            case "leave":
            case "expire":
              await this.remove(row, signal);
              break;
            case "reconcile":
              await this.reconcile(row, signal);
              break;
            case "transcript":
            case "transcript-check":
              await this.importTranscript(row, signal, payload.action === "transcript-check");
              break;
            case "cleanup":
              await this.cleanupRecording(row, signal);
              break;
          }
        },
      ),
    );
  }

  private async dispatch(row: Session, signal: AbortSignal) {
    const { prisma, jobs } = this.deps;
    const provider = this.provider();
    if (row.externalId || row.closedAt || row.status !== "joining") return;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.finish(row, "failed", errors.join);
      return;
    }
    if (row.requestedAt) {
      // The provider may have accepted a request whose response we lost. Never create a second bot.
      const recovered = await provider.find(row.id, signal);
      if (!recovered) throw new Error("Waiting to reconcile the meeting join");
      await this.observe(row.id, recovered);
      return;
    }
    const bot = await prisma.bot.findFirst({
      where: { id: row.botId, spaceId: row.spaceId, archivedAt: null },
      select: { name: true },
    });
    if (!row.meetingUrl || !bot || !(await this.member(row))) {
      await this.finish(row, "failed", errors.join);
      return;
    }
    const input: MeetingJoinRequest = {
      sessionId: row.id,
      meetingUrl: row.meetingUrl,
      platform: MeetingPlatformSchema.parse(row.platform),
      botName: `${bot.name.slice(0, 88)} · Rakazo`,
      expiresAt: row.expiresAt,
    };
    const { count } = await prisma.meetingSession.updateMany({
      // The per-session lease owns dispatch. Save when the create was sent so recovery knows
      // a missing response could already have created a participant.
      where: { id: row.id, externalId: null, status: "joining" },
      data: { requestedAt: new Date() },
    });
    if (!count) return;
    try {
      const request = this.deps.buildJoin ? await this.deps.buildJoin(input) : input;
      const observation = await provider.join(request, signal);
      await this.observe(row.id, observation);
      // The bot record can be deleted while a vendor request is in flight.
      if (!(await prisma.meetingSession.count({ where: { id: row.id } }))) {
        const cleanup = workJob(row.id, "expire", new Date(Date.now() + BACKUP_AFTER));
        cleanup.payload.detached = { provider: row.provider, externalId: observation.externalId };
        await jobs.enqueue(cleanup);
        await provider.leave(observation.externalId, signal);
        await jobs.cancel(workKey(row.id, "expire"));
      }
    } catch (error) {
      if (!(error instanceof MeetingJoinRejected)) throw error;
      if (error.retryAfterMs === undefined) {
        await this.finish(row, "failed", errors.join);
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.meetingSession.updateMany({
            where: { id: row.id, externalId: null, status: "joining" },
            data: { requestedAt: null },
          });
          await jobs.enqueueIn(
            tx,
            workJob(row.id, "join", new Date(Date.now() + error.retryAfterMs!)),
          );
        });
        return "rescheduled";
      }
    }
  }

  private async remove(row: Session, signal: AbortSignal) {
    const { prisma, jobs } = this.deps;
    const provider = this.provider();
    if (row.closedAt) return;
    if (!row.externalId) {
      const recovered = row.requestedAt ? await provider.find(row.id, signal) : null;
      if (recovered) {
        await this.observe(row.id, recovered);
        await this.remove({ ...row, externalId: recovered.externalId }, signal);
        return;
      }
      if (row.requestedAt && row.expiresAt.getTime() > Date.now()) {
        throw new Error("Waiting to reconcile the meeting before removing it");
      }
      await this.finish(row, row.status === "leaving" ? "ended" : "failed");
      return;
    }
    await prisma.meetingSession.updateMany({
      where: {
        id: row.id,
        closedAt: null,
        status: { notIn: ["failed", "ready", "ended", "processing"] },
      },
      data: { status: "leaving" },
    });
    const result = await provider.leave(row.externalId, signal);
    if (result) {
      const actions = await this.observe(row.id, result);
      // The transaction has already written the backup for any next step.
      for (const action of actions) {
        if (action === "transcript") {
          const updated = await prisma.meetingSession.findUniqueOrThrow({ where: { id: row.id } });
          await this.importTranscript(updated, signal);
          await jobs.cancel(workKey(row.id, action));
        }
      }
    } else {
      await jobs.enqueue(workJob(row.id, "reconcile", new Date(Date.now() + BACKUP_AFTER)));
    }
    await this.notify(row.spaceId);
  }

  private async reconcile(row: Session, signal: AbortSignal) {
    if (!row.externalId || ["joined", "ready", "ended"].includes(row.status)) return;
    const provider = this.provider();
    const current = await provider.get(row.externalId, signal);
    if (!current) {
      await this.finish(row, "ended");
      return;
    }
    await this.observe(row.id, current);
  }

  private async importTranscript(row: Session, signal: AbortSignal, deadline = false) {
    const { prisma, jobs } = this.deps;
    const provider = this.provider();
    if (!row.recordingId || row.status !== "processing") return;
    if (!(await this.member(row))) {
      await provider.deleteRecording(row.recordingId, signal);
      await this.finish(row, "ended");
      return;
    }
    const artifact =
      deadline && row.transcriptId
        ? { id: row.transcriptId, ready: await provider.transcriptReady(row.transcriptId, signal) }
        : await provider.requestTranscript(row.recordingId, signal);
    if (!artifact.ready) {
      if (deadline) {
        await this.finish(row, "failed", errors.transcript);
        return;
      }
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.meetingSession.updateMany({
          where: { id: row.id, status: "processing", transcriptId: null },
          data: { transcriptId: artifact.id },
        });
        if (count) {
          await jobs.enqueueIn(
            tx,
            workJob(row.id, "transcript-check", new Date(Date.now() + TRANSCRIPT_DEADLINE)),
          );
        }
      });
      return;
    }
    const bot = await prisma.bot.findUnique({ where: { id: row.botId }, select: { name: true } });
    const turns = await provider.downloadTranscript(artifact.id, signal, { selfName: bot?.name });
    const artifactAdded = await prisma.$transaction(async (tx) => {
      const { count } = await tx.meetingSession.updateMany({
        where: { id: row.id, status: "processing", recordingId: row.recordingId },
        data: {
          status: "ready",
          transcript: JSON.stringify(turns),
          transcriptId: artifact.id,
          error: null,
        },
      });
      if (count) {
        if (row.shareTranscript) {
          await tx.artifact.create({ data: meetingTranscriptArtifact(row, turns) });
        }
        const cleanup = workJob(row.id, "cleanup", new Date(Date.now() + BACKUP_AFTER));
        cleanup.payload.detached = { provider: row.provider, recordingId: row.recordingId! };
        await jobs.enqueueIn(tx, cleanup);
      }
      return Boolean(count && row.shareTranscript);
    });
    await this.notify(row.spaceId, artifactAdded);
    await this.cleanupRecording({ ...row, recordingId: row.recordingId }, signal);
    await jobs.cancel(workKey(row.id, "cleanup"));
  }

  private async cleanupRecording(row: Session, signal: AbortSignal) {
    if (!row.recordingId) return;
    await this.provider().deleteRecording(row.recordingId, signal);
    await this.deps.prisma.meetingSession.updateMany({
      where: { id: row.id, recordingId: row.recordingId },
      data: { recordingId: null },
    });
  }

  private async observe(id: string, event: MeetingObservation): Promise<JobAction[]> {
    const { prisma, jobs } = this.deps;
    const actions = await runAsSystem("apply meeting provider observation", () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM meeting_sessions WHERE id = ${id} FOR UPDATE`;
        const row = await tx.meetingSession.findUnique({ where: { id } });
        if (
          !row ||
          row.provider !== this.providerId ||
          (row.externalId && row.externalId !== event.externalId)
        )
          return;
        if (row.receivedAt && event.occurredAt < row.receivedAt && !event.recordingId) return;
        const next = nextObservation(row, event);
        if (!row.externalId || next.data) {
          await tx.meetingSession.update({
            where: { id },
            data: { externalId: event.externalId, meetingUrl: null, ...next.data },
          });
        }
        if (
          (!row.externalId &&
            (!event.status || event.status === "joining" || event.status === "waiting")) ||
          (!row.closedAt && event.status === "processing" && !event.recordingId)
        ) {
          const wait = event.status === "processing" ? 2 * MINUTE : 4 * MINUTE;
          await jobs.enqueueIn(tx, workJob(id, "reconcile", new Date(Date.now() + wait)));
        }
        if (!row.externalId && !row.closedAt) {
          const expiry = workJob(id, "expire", row.expiresAt);
          expiry.payload.detached = { provider: row.provider, externalId: event.externalId };
          await jobs.enqueueIn(tx, expiry);
        }
        for (const action of next.actions) {
          await jobs.enqueueIn(tx, workJob(id, action, new Date(Date.now() + BACKUP_AFTER)));
        }
        return { spaceId: row.spaceId, actions: next.actions };
      }),
    );
    if (!actions) return [];
    await this.notify(actions.spaceId);
    return actions.actions;
  }

  private async finish(row: Session, status: "ended" | "failed", error?: string) {
    await this.deps.prisma.meetingSession.updateMany({
      where: { id: row.id, status: row.status, closedAt: row.closedAt },
      data: { status, error, closedAt: new Date(), activeKey: null, meetingUrl: null },
    });
    await this.notify(row.spaceId);
  }

  private async attempt(sessionId: string, action: JobAction) {
    await bestEffort(
      "start meeting work",
      (async () => {
        const result = await this.work({ sessionId, action });
        if (result !== "rescheduled") await this.deps.jobs.cancel(workKey(sessionId, action));
      })(),
    );
  }

  private async bot(actor: Actor, botId: string) {
    const bot = await this.deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true, name: true },
    });
    if (!bot) throw new ClientError("NOT_FOUND", "Bot not found.");
    return bot;
  }

  private async session(actor: Actor, id: string, includeTranscript = false) {
    const row = await this.deps.prisma.meetingSession.findFirst({
      where: { id, spaceId: actor.spaceId, userId: actor.userId },
      omit: { transcript: !includeTranscript },
    });
    if (!row) throw new ClientError("NOT_FOUND", "Meeting not found.");
    return row;
  }

  private async member(row: Pick<Session, "spaceId" | "userId">) {
    return this.deps.prisma.spaceMember.findFirst({
      where: {
        spaceId: row.spaceId,
        userId: row.userId,
        member: { user: { deactivatedAt: null } },
      },
      select: { id: true },
    });
  }

  private requireEnabled(spaceId: string) {
    if (!this.enabled(spaceId))
      throw new ClientError("FORBIDDEN", "Meetings are unavailable in this Space.");
  }

  private async notify(spaceId: string, artifactsChanged = false) {
    const meetings = this.deps.events.publishSpaceChange?.(spaceId, "meetings");
    if (artifactsChanged) {
      await Promise.all([meetings, this.deps.events.publishSpaceChange?.(spaceId, "artifacts")]);
      return;
    }
    await meetings;
  }
}

function nextObservation(
  row: Session,
  event: MeetingObservation,
): {
  data?: Prisma.MeetingSessionUpdateInput;
  actions: JobAction[];
} {
  const actions: JobAction[] = [];
  if (row.status === "ready" || (row.status === "ended" && row.transcriptId)) return { actions };
  if (!event.status) return { actions };
  if (event.recordingId && row.recordingId && event.recordingId !== row.recordingId)
    return { actions };
  let status = event.status;
  let closedAt = row.closedAt;
  if (event.status === "processing" || event.status === "ended") {
    closedAt ??= event.occurredAt;
    if (event.status === "ended" && row.recordingId) status = "processing";
    if (event.recordingId) actions.push("transcript");
  } else if (event.status === "failed") {
    if (event.error === "join" || event.error === "admission") closedAt ??= event.occurredAt;
    else if (!closedAt) actions.push("leave");
  } else {
    if (row.status === "failed" && !row.externalId && row.requestedAt) {
      return { data: { closedAt: null }, actions: ["leave"] };
    }
    if (row.closedAt) return { actions };
    if (row.status === "leaving" || row.status === "failed") return { actions: ["leave"] };
    if (row.status === "joined" || (row.status === "waiting" && event.status === "joining"))
      return { actions };
  }
  if (row.error && status === "ended") status = "failed";
  return {
    data: {
      status,
      receivedAt:
        row.receivedAt && row.receivedAt > event.occurredAt ? row.receivedAt : event.occurredAt,
      closedAt,
      ...(closedAt ? { activeKey: null } : {}),
      recordingId: event.recordingId ?? row.recordingId,
      transcriptId: event.transcriptId ?? row.transcriptId,
      ...(event.error ? { error: errors[event.error] } : {}),
    },
    actions,
  };
}

type MeetingQuotaReader = Pick<Prisma.TransactionClient, "meetingSession">;

export function meetingUtcDayStart(timestamp: number) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

/** Count paid usage and outstanding reservations together on the same UTC day. */
export function countSpaceMeetingsForDay(prisma: MeetingQuotaReader, spaceId: string, date: Date) {
  const start = meetingUtcDayStart(date.getTime());
  return countSpaceMeetings(prisma, spaceId, {
    gte: new Date(start),
    lt: new Date(start + DAY_MS),
  });
}

/** Manual admission also limits recent usage across UTC midnight. */
export function countSpaceMeetingsInPastDay(
  prisma: MeetingQuotaReader,
  spaceId: string,
  now: Date,
) {
  return countSpaceMeetings(prisma, spaceId, {
    gt: new Date(now.getTime() - DAY_MS),
    lte: now,
  });
}

function countSpaceMeetings(
  prisma: MeetingQuotaReader,
  spaceId: string,
  time: { gte: Date; lt: Date } | { gt: Date; lte: Date },
) {
  return prisma.meetingSession.count({
    where: {
      spaceId,
      OR: [
        { scheduledFor: null, createdAt: time },
        {
          scheduledFor: time,
          OR: [{ status: { not: "ended" } }, { receivedAt: { not: null } }],
        },
      ],
    },
  });
}
