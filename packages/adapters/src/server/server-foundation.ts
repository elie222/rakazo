import type {
  JobPublisher,
  NotificationProvider,
  ProductAnalytics,
  RealtimeFanout,
  SecretStore,
} from "@rakazo/adapter-kit";
import { resolveMeetingSigningKey } from "@rakazo/core/node/secrets-guard";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  createThreadEvents,
  describeRowSecurity,
  installAuditEventStore,
  installSecurityEventStore,
  observeThreadChanges,
  pushSessionExpiresAt,
  rowSecurityWarning,
  timeZoneWarning,
  verifyContentKeys,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { createProductAnalytics } from "../analytics/product-analytics.js";
import type { ApnsVoipConfig } from "../calls/apns-voip.js";
import { createApnsActivityProvider, createApnsVoipProvider } from "../calls/apns-voip-config.js";
import { meetingCalendarScope } from "../meetings/calendar/calendar-notifications.js";
import { MeetingCalendarService } from "../meetings/calendar/calendar-service.js";
import { configuredMeetingMedia } from "../meetings/meeting-media-grant.js";
import {
  configuredMeetingProviders,
  configuredMeetingSpaces,
} from "../meetings/meeting-provider.js";
import { MeetingService } from "../meetings/meeting-service.js";
import { ChatSdkMessagingSurface } from "../messaging/chat-sdk-surface.js";
import { installedMessaging } from "../messaging/messaging-composition.js";
import type { MessagingEnvironmentValues } from "../messaging/messaging-platforms.js";
import {
  isMessagingSurfaceEnabled,
  messagingPlatformsFromEnv,
} from "../messaging/messaging-platforms.js";
import { ExpoPushProvider } from "../notifications/expo-push.js";
import { PrismaPushTokenStore } from "../notifications/push-token-store.js";
import { WorkActivities } from "../runs/lifecycle/work-activity.js";
import { createRunSecretWriter } from "../secrets/run-secret.js";
import { withSecretWriteAhead } from "../secrets/secret-cleanup.js";
import { withSecretPersistence } from "../secrets/secret-persistence.js";
import { createSecretStore } from "../secrets/secret-store-factory.js";

/** Where a local development stack serves the web client. */
const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:5173";

/**
 * An origin used to build absolute links, or the fallback when unset. Trailing slashes are
 * dropped so `${webOrigin}/path` cannot produce `https://host//path`; providers reject a
 * double-slash redirect URI as a mismatch against the one registered with them.
 */
export function absoluteHttpOrigin(value: string | undefined, fallback: string, name: string) {
  const configured = value?.trim() || fallback;
  // A loop rather than a trailing-slash regex, which backtracks on a long run of slashes.
  let end = configured.length;
  while (end > 0 && configured[end - 1] === "/") end -= 1;
  const origin = configured.slice(0, end);
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return origin;
}

/** The web client's origin, read the same way in the API and the worker. */
export function webOriginFromEnv(source: Record<string, string | undefined>) {
  return absoluteHttpOrigin(source.WEB_ORIGIN, DEFAULT_WEB_ORIGIN, "WEB_ORIGIN");
}

/** A secret store that has finished starting; a remote store that is down starts degraded. */
export async function startSecretStore(
  encryptionKey: string,
  source: NodeJS.ProcessEnv,
  realtime?: RealtimeFanout,
): Promise<SecretStore> {
  const store = createSecretStore(encryptionKey, source, realtime);
  await store.start();
  return store;
}

export type ServerFoundation = {
  prisma: PrismaClient;
  realtime: RealtimeFanout;
  secrets: SecretStore;
  analytics: ProductAnalytics | undefined;
  events: ThreadEvents;
  /** The queue built from this client; a secret written or dropped before then gets no backup. */
  useJobs: (jobs: JobPublisher) => void;
  /** Push delivery built later; thread changes before then update no live status cards. */
  useWorkActivities: (workActivities: WorkActivities | undefined) => void;
};

/**
 * The database, secrets and events every server process builds first, in the same order: the API
 * and the worker differ only in the client and fanout they pass in.
 */
export async function startServerFoundation(input: {
  prisma: PrismaClient;
  realtime: RealtimeFanout;
  encryptionKey: string;
}): Promise<ServerFoundation> {
  const logger = getLogger();
  let prisma = input.prisma;
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const timeZone = await bestEffort("database time zone check", timeZoneWarning(prisma));
  if (timeZone) logger.warn(timeZone);
  let workActivities: WorkActivities | undefined;
  // Every thread change this process commits also updates its users' live status cards.
  const realtime = observeThreadChanges(input.realtime, (threadId) =>
    workActivities?.threadChanged(threadId),
  );
  let secretCleanupJobs: JobPublisher | undefined;
  const secrets = withSecretWriteAhead(
    await startSecretStore(input.encryptionKey, process.env, realtime),
    () => secretCleanupJobs,
  );
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets, () => secretCleanupJobs);
  installSecurityEventStore(prisma);
  installAuditEventStore(prisma);
  const unreadableMasterKeys = await verifyContentKeys(prisma);
  if (unreadableMasterKeys.length)
    logger.error("Stored space keys need master keys that are not configured", undefined, {
      masterKeyIds: unreadableMasterKeys,
    });
  const analytics = createProductAnalytics();
  const events = createThreadEvents(prisma, realtime, {
    analytics,
    runSecretWriter: createRunSecretWriter(secrets),
  });
  return {
    prisma,
    realtime,
    secrets,
    analytics,
    events,
    useJobs: (jobs) => {
      secretCleanupJobs = jobs;
    },
    useWorkActivities: (next) => {
      workActivities = next;
    },
  };
}

/** Phone push, VoIP calls and live status cards, built alike in the API and the worker. */
export async function createPushDelivery(input: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  encryptionKey: string;
  expoAccessToken: string | undefined;
  apnsVoip: ApnsVoipConfig | undefined;
  /** Test-only stand-in; no push provider is built beside it. */
  notifications?: NotificationProvider;
}) {
  const { prisma, encryptionKey, apnsVoip } = input;
  const pushTokens = new PrismaPushTokenStore(prisma, encryptionKey);
  const notifications =
    input.notifications ??
    new ExpoPushProvider(pushTokens, {
      sessionExpiresAt: (sessionId) => pushSessionExpiresAt(prisma, sessionId),
      jobs: input.jobs,
      accessToken: input.expoAccessToken,
      voip: await createApnsVoipProvider(apnsVoip),
    });
  const activityPush = await createApnsActivityProvider(apnsVoip);
  const workActivities = activityPush
    ? new WorkActivities(prisma, encryptionKey, activityPush)
    : undefined;
  return { pushTokens, notifications, workActivities };
}

/**
 * The chat apps this deployment connects. `pollInboundMessages` is true only in the one process
 * that registers the inbound sink: Telegram allows a single getUpdates consumer.
 */
export function configuredMessaging(input: {
  prisma: PrismaClient;
  secrets: SecretStore;
  jobs: JobPublisher;
  env: MessagingEnvironmentValues & { slackClientId?: string; slackClientSecret?: string };
  deploymentModelConfigured: boolean;
  openSignup: boolean;
  pollInboundMessages: boolean;
}) {
  const { env } = input;
  const platforms = messagingPlatformsFromEnv(env, {
    pollInboundMessages: input.pollInboundMessages,
  }).filter((platform) => platform.provider !== "slack" || !env.slackClientId);
  const legacy = isMessagingSurfaceEnabled(platforms, {
    deploymentModelConfigured: input.deploymentModelConfigured,
    openSignup: input.openSignup,
  })
    ? new ChatSdkMessagingSurface(platforms)
    : undefined;
  return installedMessaging(input.prisma, input.secrets, env, legacy, input.jobs);
}

/** The configured meeting and calendar providers and the services over them. */
export async function createMeetingServices(input: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
  webOrigin: string;
}) {
  const { prisma, jobs, events } = input;
  const { meeting: provider, calendar: calendarProvider } = await configuredMeetingProviders();
  const media = provider && configuredMeetingMedia();
  const meetings = new MeetingService({
    prisma,
    jobs,
    events,
    provider,
    spaceIds: provider && configuredMeetingSpaces(provider),
    buildJoin: media?.buildJoin,
  });
  const calendar =
    calendarProvider &&
    new MeetingCalendarService({
      prisma,
      jobs,
      provider: calendarProvider,
      webOrigin: input.webOrigin,
      oauthStateKey: resolveMeetingSigningKey(),
      enabled: (spaceId) => meetings.enabled(spaceId),
      buildJoin: media?.buildJoin ?? ((join) => join),
      publish: async ({ spaceId, userId }) => {
        await events.publishSpaceChange?.(meetingCalendarScope(spaceId, userId), "meetingCalendar");
      },
    });
  return { provider, media, meetings, calendar };
}

/** Closes what every server process holds, after its own work has stopped. */
export async function closeServerFoundation(
  { prisma, secrets, realtime }: Pick<ServerFoundation, "prisma" | "secrets" | "realtime">,
  held: {
    jobs: Pick<JobPublisher, "close">;
    connectors: { mcp: { close(): Promise<void> }; installed: { close(): Promise<void> } };
  },
) {
  await held.jobs.close();
  await secrets.close();
  await realtime.close();
  await held.connectors.mcp.close();
  await held.connectors.installed.close();
  await bestEffort("disconnect database client", prisma.$disconnect());
}
