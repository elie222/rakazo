import { createHash, createHmac, randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import {
  MeetingCalendarConnectRejected,
  MeetingCalendarConnectUnavailable,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  DESKTOP_MEETING_CALENDAR_LAUNCH_PATH,
  MEETING_CALENDAR_CALLBACK_PATH,
} from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import { assertLeaseHeld, runAsSystem, runAsTenant, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { MeetingCalendarOptions } from "./calendar-service.js";

const OAUTH_SESSION_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
type Owner = Pick<Actor, "spaceId" | "userId">;
type CalendarSyncJob = Extract<BackgroundJob, { name: "meeting.calendar-sync" }> & {
  replaceKey: string;
  queueName: string;
  availableAt: Date;
};

export function signCalendarConnectionRef(key: string, id: string) {
  const signature = createHmac("sha256", key)
    .update(`meeting-calendar-connection:${id}`)
    .digest("base64url");
  return `${id}.${signature}`;
}

export class CalendarAuthorization {
  constructor(
    private readonly options: Pick<
      MeetingCalendarOptions,
      "prisma" | "jobs" | "provider" | "webOrigin" | "oauthStateKey" | "enabled"
    >,
    private readonly scheduler: {
      backup: (connectionId: string, workMs: number) => CalendarSyncJob;
      run: (job: CalendarSyncJob) => Promise<void>;
    },
    private readonly now: () => Date,
  ) {}

  async begin(
    { spaceId, userId }: Owner,
    client: "web" | "mobile" | "desktop",
    options?: {
      botId?: string;
      loopbackPort?: number;
      sessionId?: string;
    },
  ) {
    if (!this.options.enabled(spaceId))
      throw new ClientError("FORBIDDEN", "Calendar scheduling is unavailable in this Space.");
    const { prisma, webOrigin } = this.options;
    if (
      await prisma.meetingCalendarConnection.findFirst({
        where: { spaceId, userId, provider: this.options.provider.id },
      })
    ) {
      throw new ClientError(
        "CONFLICT",
        "Disconnect the current calendar before connecting another.",
      );
    }
    const state =
      client === "desktop"
        ? `desktop-${options?.loopbackPort}-${randomUUID()}`
        : `${client}-${randomUUID()}`;
    const loopback = this.desktopLoopback(state);
    if (
      client === "desktop" &&
      (!options?.sessionId || !loopback || new URL(webOrigin).protocol !== "https:")
    ) {
      throw new ClientError(
        "BAD_REQUEST",
        "Desktop calendar sign-in requires a public HTTPS address.",
      );
    }
    const authorization = {
      id: state,
      expiresAt: new Date(this.now().getTime() + OAUTH_SESSION_MS),
      sessionId: client === "desktop" ? options?.sessionId : null,
      botId: client === "web" ? (options?.botId ?? null) : null,
    };
    await prisma.meetingCalendarAuthorization.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      create: { ...authorization, spaceId, userId },
      update: authorization,
    });

    if (!loopback) return { state, authorizationUrl: this.providerAuthorizationUrl(state) };
    // The native app's existing browser-auth bridge listens on this loopback
    // address. The provider still gets the deployment's registered HTTPS URI.
    const launch = new URL(DESKTOP_MEETING_CALENDAR_LAUNCH_PATH, webOrigin);
    launch.searchParams.set("state", state);
    launch.searchParams.set("redirect_uri", loopback.href);
    return { state, authorizationUrl: launch.href };
  }

  async launchDesktop(state: string) {
    return (await this.desktopHandoff(state)) ? this.providerAuthorizationUrl(state) : null;
  }

  async desktopHandoff(state: string) {
    const loopback = this.desktopLoopback(state);
    if (!loopback) return null;
    const valid = await runAsSystem("verify calendar desktop sign-in handoff", async () => {
      const auth = await this.options.prisma.meetingCalendarAuthorization.findFirst({
        where: { id: state, expiresAt: { gt: this.now() }, sessionId: { not: null } },
      });
      if (!auth?.sessionId || !this.options.enabled(auth.spaceId)) return false;
      const [session, member] = await Promise.all([
        this.options.prisma.session.findFirst({
          where: { id: auth.sessionId, userId: auth.userId, expiresAt: { gt: this.now() } },
          select: { id: true },
        }),
        this.options.prisma.spaceMember.findFirst({
          where: {
            spaceId: auth.spaceId,
            userId: auth.userId,
            member: { user: { deactivatedAt: null } },
            space: { deletionClaimId: null },
          },
          select: { id: true },
        }),
      ]);
      return Boolean(session && member);
    });
    return valid ? loopback : null;
  }

  async completeFromBrowser(userId: string, state: string, code: string) {
    const authorization = await runAsSystem(
      "find an authorization belonging to the signed-in calendar user",
      async () => {
        const authorization = await this.options.prisma.meetingCalendarAuthorization.findFirst({
          where: { id: state, userId, expiresAt: { gt: this.now() } },
          select: { spaceId: true, userId: true, botId: true },
        });
        if (!authorization) return null;
        const member = await this.options.prisma.spaceMember.findUnique({
          where: {
            spaceId_userId: { spaceId: authorization.spaceId, userId: authorization.userId },
          },
          select: { id: true },
        });
        return member ? authorization : null;
      },
    );
    if (!authorization) throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
    const { botId, ...owner } = authorization;
    await runAsTenant(owner, () => this.complete(owner, state, code));
    return botId;
  }

  async complete(actor: Owner, state: string, code: string, sessionId?: string) {
    if (!this.options.enabled(actor.spaceId))
      throw new ClientError("FORBIDDEN", "Calendar scheduling is unavailable in this Space.");
    const { prisma, provider, webOrigin } = this.options;
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    const connectionId = randomUUID();
    const backup = this.scheduler.backup(connectionId, CONNECT_TIMEOUT_MS);
    await withLease(
      prisma,
      `meeting-calendar:${connectionId}`,
      { ttlMs: 30_000, signal: deadlineSignal(CONNECT_TIMEOUT_MS) },
      async (lease) => {
        await prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          if (this.desktopLoopback(state) && !sessionId) {
            throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
          }
          const consumed = await tx.meetingCalendarAuthorization.deleteMany({
            where: {
              ...scope,
              id: state,
              expiresAt: { gt: this.now() },
              sessionId: this.desktopLoopback(state) ? sessionId : null,
            },
          });
          if (!consumed.count) {
            throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
          }
          if (await tx.meetingCalendarConnection.findUnique({ where: { spaceId_userId: scope } })) {
            throw new ClientError("CONFLICT", "A calendar is already connected in this Space.");
          }
          // Keep access checks and the reservation in one transaction. Revocation and
          // deletion either precede this check or see the row they must disconnect.
          const [member] = await tx.$queryRaw<{ id: string }[]>`
            SELECT sm.id
            FROM space_members sm
            JOIN "user" u ON u.id = sm."userId"
            JOIN spaces s ON s.id = sm."spaceId"
            WHERE sm."spaceId" = ${scope.spaceId} AND sm."userId" = ${scope.userId}
              AND u."deactivatedAt" IS NULL AND s."deletionClaimId" IS NULL
            FOR SHARE OF sm, u, s
          `;
          if (!member)
            throw new ClientError("FORBIDDEN", "Calendar access is no longer available.");
          await tx.meetingCalendarConnection.create({
            data: { ...scope, id: connectionId, provider: provider.id, createdAt: this.now() },
          });
          await this.options.jobs.enqueueIn(tx, backup);
        });

        const { calendarId } = await provider
          .connect(
            {
              connectionRef: signCalendarConnectionRef(this.options.oauthStateKey, connectionId),
              code,
              verifier: this.verifier(state),
              redirectUri: this.redirectUri(webOrigin),
            },
            lease.signal,
          )
          .catch(async (error: unknown) => {
            if (
              !(
                error instanceof MeetingCalendarConnectRejected ||
                error instanceof MeetingCalendarConnectUnavailable
              )
            ) {
              throw new ClientError(
                "SERVICE_UNAVAILABLE",
                "Calendar sign-in could not be confirmed. Check the connection in Rakazo.",
                undefined,
                { cause: error },
              );
            }
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              await tx.meetingCalendarConnection.deleteMany({
                where: { id: connectionId, externalCalendarId: null },
              });
              await this.options.jobs.cancelIn(tx, backup.replaceKey);
            });
            if (error instanceof MeetingCalendarConnectUnavailable) {
              throw new ClientError(
                "SERVICE_UNAVAILABLE",
                "Calendar sign-in is temporarily unavailable.",
                undefined,
                { cause: error },
              );
            }
            throw new ClientError("BAD_REQUEST", error.message);
          });

        // A disconnect can mark the row during the exchange. Preserve that intent
        // while recording which provider calendar recovery must remove.
        await prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          await tx.meetingCalendarConnection.update({
            where: { id: connectionId },
            data: { externalCalendarId: calendarId },
          });
        });
      },
    );
    await bestEffort("reconcile newly connected calendar", this.scheduler.run(backup));
  }

  private providerAuthorizationUrl(state: string) {
    const challenge = createHash("sha256").update(this.verifier(state)).digest("base64url");
    return this.options.provider.authorizationUrl({
      state,
      challenge,
      redirectUri: this.redirectUri(this.options.webOrigin),
    });
  }

  private desktopLoopback(state: string) {
    const match = /^desktop-(\d{5})-[0-9a-f-]{36}$/u.exec(state);
    const port = Number(match?.[1]);
    if (!match || port < 49_152 || port > 65_535) return null;
    return new URL(`http://127.0.0.1:${port}/meeting-calendar/callback`);
  }

  private verifier(state: string) {
    return createHmac("sha256", this.options.oauthStateKey)
      .update(`meeting-calendar:${state}`)
      .digest("base64url");
  }

  private redirectUri(webOrigin: string) {
    return new URL(MEETING_CALENDAR_CALLBACK_PATH, webOrigin).toString();
  }
}
