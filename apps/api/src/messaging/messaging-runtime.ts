import type {
  ArtifactStore,
  JobPublisher,
  JobQueueOrder,
  MessagingInboundEvent,
  MessagingSurface,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { MessagingDelivery, MessagingInstallations, TeamChat } from "@rakazo/adapters";
import { applyMessagingOutboundStatus, createMessagingTeamChatHistory } from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { transcribeInboundVoice } from "../calls/voice.js";
import { storeInboundAttachment } from "../content/artifacts.js";
import type { AppEnv } from "../env.js";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { createDownloadBudget } from "./intake/download-budget.js";
import { DOWNLOAD_BUDGET_FILES } from "./intake/limits.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";
import { prefersTeamChatSurface } from "./team-chat-startup.js";

/**
 * Messaging and team chat for one API process; `stopReceiving` ends polling while replies still
 * send, and `stop` also hands direct messages still settling to their backup jobs and ends
 * receipts.
 */
export async function startMessagingRuntime({
  app,
  prisma,
  events,
  jobs,
  sandbox,
  secrets,
  artifacts,
  env,
  messaging,
  messagingInstallations,
  delivery,
  teamChat,
}: {
  app: Hono;
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancelIn"> & JobQueueOrder;
  sandbox: SandboxProvider;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  env: AppEnv;
  messaging: MessagingSurface;
  messagingInstallations: MessagingInstallations | undefined;
  delivery: MessagingDelivery;
  teamChat: TeamChat;
}): Promise<{ stopReceiving: () => Promise<void>; stop: () => Promise<void> }> {
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let clearMessagingRetryDelay: (() => void) | undefined;
  const receipts = createMessagingReceipts(messaging);
  const stores = createInboundAttachmentStores({
    prisma,
    artifacts,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
  });
  const inboundDeps = {
    prisma,
    events,
    jobs,
    delivery,
    sandbox,
    provision: (request) => provisionMessagingIdentity(prisma, request),
    openSignup: env.messagingOpenSignup,
    acknowledge: receipts.acknowledge,
    storeAttachment: stores.direct,
    transcribe: ({ spaceId, userId, audio, mimeType, signal }) =>
      transcribeInboundVoice(
        {
          prisma,
          secrets,
          env: {
            mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
            deploymentVoice: env.deploymentVoice,
          },
        },
        { spaceId, userId },
        { audio, mimeType, signal },
      ),
  } satisfies Parameters<typeof createMessagingInboundHandler>[0];
  const inbound = createMessagingInboundHandler(inboundDeps);
  const handleTeamChatInbound = createTeamChatInboundHandler(inboundDeps, inbound, teamChat);
  const bridges = new Map<string, TeamChatBridge>();
  /** One bridge per bot and connected workspace; it holds no timers, so it is never stopped. */
  const bridgeFor = (botId: string, installation?: { id: string; workspaceId: string }) => {
    const key = installation?.id ?? `static:${botId}`;
    let bridge = bridges.get(key);
    if (!bridge) {
      bridge = new TeamChatBridge({
        prisma,
        teamChat,
        jobs,
        fetchThreadHistory: createMessagingTeamChatHistory(messaging),
        storeAttachment: stores.teamChat,
        providerId: "slack",
        botId,
        workspaceId: installation?.workspaceId,
        isAvailable: installation
          ? async () => Boolean(await messagingInstallations?.isActive(installation.id))
          : undefined,
        acknowledge: receipts.acknowledge,
      });
      bridges.set(key, bridge);
    }
    return bridge;
  };
  const handleInbound = async (event: MessagingInboundEvent) => {
    if (event.type !== "message") {
      await applyMessagingOutboundStatus(prisma, event);
      return;
    }
    if (event.installationBotId && !event.isDirect) {
      if (!event.installationId || !event.workspaceId) return;
      await handleTeamChatInbound(
        bridgeFor(event.installationBotId, {
          id: event.installationId,
          workspaceId: event.workspaceId,
        }),
        event,
      );
      return;
    }
    if (
      !event.installationBotId &&
      env.teamChatBotId &&
      prefersTeamChatSurface(event, env.teamChatBotId)
    ) {
      await handleTeamChatInbound(bridgeFor(env.teamChatBotId), event);
      return;
    }
    await inbound(event);
  };
  messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
  mountMessagingWebhookRoutes(app, { messaging });
  // Start polling adapters now rather than on the first webhook or send; a second poller
  // elsewhere would fight this one for Telegram's single getUpdates slot. Bounded retries
  // cover transient startup failures, otherwise polling-only bots stay dark.
  const messagingInitTask = (async () => {
    const delayMs = [0, 2_000, 10_000];
    for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
      if (messagingStopped) return;
      if (delayMs[attempt]! > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs[attempt]);
          clearMessagingRetryDelay = () => {
            clearTimeout(timer);
            clearMessagingRetryDelay = undefined;
            resolve();
          };
        });
        clearMessagingRetryDelay = undefined;
      }
      if (messagingStopped) return;
      try {
        await messaging.initialize?.();
        return;
      } catch (error) {
        getLogger().error(
          attempt === delayMs.length - 1
            ? "messaging surface initialize failed"
            : "messaging surface initialize failed; retrying",
          error,
        );
      }
    }
  })();
  const stopReceiving = async () => {
    // First, while the process is surely still up: the backup jobs of direct messages still
    // settling are due soon, should it be killed before `stop` hands them over.
    const handOffPrepared = inbound.prepareHandOff();
    messagingStopped = true;
    clearMessagingRetryDelay?.();
    await messagingInitTask.catch(() => undefined);
    await messaging.stopReceiving?.();
    await handOffPrepared;
  };
  return {
    stopReceiving,
    stop: async () => {
      await stopReceiving();
      // Downloads still running here get what is left of the grace; then their jobs take over.
      await inbound.handOffPending();
      receipts.stop();
      await messaging.shutdown?.();
    },
  };
}

/**
 * The attachment stores of one process. Direct-message files share its download budget and take
 * the time they need; team-chat files keep their short wait outside it, so they never queue
 * behind a direct message's video.
 */
export function createInboundAttachmentStores(deps: {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  maxUploadSizeBytes: number;
}): { direct: InboundAttachmentStore; teamChat: InboundAttachmentStore } {
  const downloadBudget = createDownloadBudget(DOWNLOAD_BUDGET_FILES * deps.maxUploadSizeBytes);
  const store =
    (budget?: typeof downloadBudget): InboundAttachmentStore =>
    ({ spaceId, userId, ...input }) =>
      storeInboundAttachment(
        { ...deps, ...(budget ? { downloadBudget: budget } : {}) },
        { spaceId, userId },
        input,
      );
  return { direct: store(downloadBudget), teamChat: store() };
}
