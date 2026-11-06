import type {
  AgentRuntime,
  ArtifactStore,
  JobPublisher,
  MessagingInboundEvent,
  MessagingSurface,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { MessagingInstallations } from "@rakazo/adapters";
import {
  applyMessagingOutboundStatus,
  createMessagingTeamChatHistory,
  createMessagingTeamChatSender,
} from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { storeInboundAttachment } from "./artifacts.js";
import type { AppEnv } from "./env.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
  TeamChatStartupRetries,
} from "./team-chat-startup.js";
import { transcribeInboundVoice } from "./voice.js";

/** Messaging and team chat for one API process; `stop` ends polling, retries, and bridges. */
export async function startMessagingRuntime({
  app,
  prisma,
  events,
  jobs,
  sandbox,
  secrets,
  artifacts,
  runtime,
  env,
  messaging,
  messagingInstallations,
}: {
  app: Hono;
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: Pick<JobPublisher, "enqueue">;
  sandbox: SandboxProvider;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  runtime: AgentRuntime;
  env: AppEnv;
  messaging: MessagingSurface;
  messagingInstallations: MessagingInstallations | undefined;
}): Promise<{ stop: () => Promise<void> }> {
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let stopInstalledBridges: (() => Promise<void>) | undefined;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearTeamChatRetryDelay: (() => void) | undefined;
  let teamChatInitTask: Promise<void> | undefined;
  let teamChatBridge: TeamChatBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let teamChatBridgeInstance: TeamChatBridge | undefined;
  const pendingTeamChatInbound = new PendingTeamChatInbound();
  const receipts = createMessagingReceipts(messaging);
  const inboundDeps = {
    prisma,
    events,
    jobs,
    sandbox,
    provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
    openSignup: env.messagingOpenSignup,
    signupPolicy: {
      signupsEnabled: env.signupsEnabled,
      signupAllowlist: env.signupAllowlist,
    },
    acknowledge: receipts.acknowledge,
    storeAttachment: ({ spaceId, userId, ...input }) =>
      storeInboundAttachment(
        { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
        { spaceId, userId },
        input,
      ),
    transcribe: ({ spaceId, userId, audio, mimeType, signal }) =>
      transcribeInboundVoice(
        {
          prisma,
          secrets,
          env: { mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint },
        },
        { spaceId, userId },
        { audio, mimeType, signal },
      ),
  } satisfies Parameters<typeof createMessagingInboundHandler>[0];
  const inbound = createMessagingInboundHandler(inboundDeps);
  const handleTeamChatInbound = createTeamChatInboundHandler(inboundDeps, inbound);
  const flushPendingTeamChatInbound = (bridge: TeamChatBridge) => {
    pendingTeamChatInbound.flush((event) => handleTeamChatInbound(bridge, event));
  };
  const makeTeamChatBridge = (
    botId: string,
    installation?: { id: string; workspaceId: string },
  ) => {
    const judge =
      env.teamChatJudgeProvider && env.teamChatJudgeModel
        ? new ModelTeamChatEngagementJudge({
            prisma,
            runtime,
            secrets,
            deploymentProvider: env.defaultProvider,
            deploymentModel: env.defaultModel,
            deploymentModelKey: env.deploymentModelKey,
            allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
            providerOverride: env.teamChatJudgeProvider,
            modelOverride: env.teamChatJudgeModel,
          })
        : new ModelTeamChatEngagementJudge({
            prisma,
            runtime,
            secrets,
            deploymentProvider: env.defaultProvider,
            deploymentModel: env.defaultModel,
            deploymentModelKey: env.deploymentModelKey,
            allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
          });
    const bridge = new TeamChatBridge({
      prisma,
      events,
      jobs,
      send: createMessagingTeamChatSender(messaging),
      fetchThreadHistory: createMessagingTeamChatHistory(messaging),
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
      providerId: "slack",
      botId,
      workspaceId: installation?.workspaceId,
      conversationPrefix: installation ? `slack~${installation.id}:` : undefined,
      onUnavailable: installation
        ? () => {
            installedBridges.delete(installation.id);
          }
        : undefined,
      isAvailable: installation
        ? async () => Boolean(await messagingInstallations?.isActive(installation.id))
        : undefined,
      judge,
      acknowledge: receipts.acknowledge,
    });
    return bridge;
  };
  const installedBridges = new Map<
    string,
    { bridge: TeamChatBridge; pending: Promise<TeamChatBridge> }
  >();
  const installedRetries = new TeamChatStartupRetries((error) =>
    getLogger().error("installed team chat restore failed; retrying", error),
  );
  const retryInstalledBridge = (installation: {
    id: string;
    botId: string;
    workspaceId: string;
  }) => {
    installedRetries.schedule(installation.id, () =>
      runAsSystem("retry installed team chat", async () => {
        if (messagingStopped) return;
        const active = await messagingInstallations?.isActive(installation.id);
        if (!active || messagingStopped) return;
        await installedBridge(installation);
      }),
    );
  };
  const installedBridge = (installation: { id: string; botId: string; workspaceId: string }) => {
    const existing = installedBridges.get(installation.id);
    if (existing) return existing.pending;
    const bridge = makeTeamChatBridge(installation.botId, installation);
    const pending = bridge
      .start()
      .then(() => {
        installedRetries.succeeded(installation.id);
        return bridge;
      })
      .catch(async (error) => {
        installedBridges.delete(installation.id);
        await bridge.stop();
        retryInstalledBridge(installation);
        throw error;
      });
    installedBridges.set(installation.id, { bridge, pending });
    return pending;
  };
  if (messagingInstallations) {
    await Promise.all(
      (await messagingInstallations.targets()).map((installation) =>
        runAsSystem("resume installed team chat", () => installedBridge(installation)).catch(
          (error) => {
            getLogger().error("installed team chat could not resume", error);
          },
        ),
      ),
    );
  }
  stopInstalledBridges = async () => {
    installedRetries.stop();
    // Stop first so an in-flight start() is cancelled, then bound the wait
    // as the static bridge does.
    await Promise.all(
      [...installedBridges.values()].map(({ bridge, pending }) =>
        settleWithTimeout(
          bridge
            .stop()
            .catch(() => undefined)
            .then(() => pending.catch(() => undefined)),
          TEAM_CHAT_STARTUP_SHUTDOWN_MS,
        ),
      ),
    );
  };
  if (env.teamChatBotId) {
    const bridge = makeTeamChatBridge(env.teamChatBotId);
    teamChatBridgeInstance = bridge;
    try {
      await bridge.start();
      teamChatBridge = bridge;
    } catch (error) {
      getLogger().error("team chat bridge failed to start; retrying", error);
      teamChatInitTask = (async () => {
        let delayMs = 2_000;
        while (!messagingStopped) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            clearTeamChatRetryDelay = () => {
              clearTimeout(timer);
              clearTeamChatRetryDelay = undefined;
              resolve();
            };
          });
          clearTeamChatRetryDelay = undefined;
          if (messagingStopped) return;
          try {
            await bridge.start();
            if (messagingStopped) {
              await bridge.stop();
              return;
            }
            teamChatBridge = bridge;
            flushPendingTeamChatInbound(bridge);
            return;
          } catch (retryError) {
            if (
              retryError instanceof Error &&
              retryError.message === "Team chat bridge start cancelled"
            ) {
              return;
            }
            getLogger().error("team chat bridge failed to start; retrying", retryError);
            delayMs = Math.min(delayMs * 5, 30_000);
          }
        }
      })();
    }
  }
  const handleInbound = async (event: MessagingInboundEvent) => {
    if (event.type !== "message") {
      await applyMessagingOutboundStatus(prisma, event);
      return;
    }
    if (event.installationBotId && !event.isDirect) {
      if (!event.installationId || !event.workspaceId) return;
      const installation = {
        id: event.installationId,
        botId: event.installationBotId,
        workspaceId: event.workspaceId,
      };
      await handleTeamChatInbound(await installedBridge(installation), event);
      return;
    }
    if (!event.installationBotId && prefersTeamChatSurface(event, env.teamChatBotId)) {
      const bridge = teamChatBridge;
      if (bridge) {
        await handleTeamChatInbound(bridge, event);
        return;
      }
      // Bridge is still starting (or retrying). Do not fall through to the
      // personal-line inbound path — that bypasses externalMessage ownership
      // and can wake routines for unlinked TeamChat senders.
      if (teamChatInitTask) {
        const pending = pendingTeamChatInbound.enqueue(event);
        if (!pending) {
          throw new Error("Team chat inbound buffer is full");
        }
        await pending;
        return;
      }
      throw new Error("Team chat bridge is unavailable");
    }
    await inbound(event);
  };
  messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
  mountMessagingWebhookRoutes(app, { messaging });
  // Start polling adapters now rather than on the first webhook or send; a second poller
  // elsewhere would fight this one for Telegram's single getUpdates slot. Bounded retries
  // cover transient startup failures, otherwise polling-only bots stay dark.
  messagingInitTask = (async () => {
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
  return {
    stop: async () => {
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearTeamChatRetryDelay?.();
      receipts.stop();
      pendingTeamChatInbound.reject(new Error("Team chat bridge stopped before startup"));
      // Cancel in-flight start() before awaiting the retry task so stop() cannot
      // sit on DB/reconcile work that bridge.start() is still running.
      await settleWithTimeout(
        teamChatBridgeInstance ? teamChatBridgeInstance.stop().catch(() => undefined) : undefined,
        TEAM_CHAT_STARTUP_SHUTDOWN_MS,
      );
      await messagingInitTask?.catch(() => undefined);
      await settleWithTimeout(teamChatInitTask, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
      await messaging.shutdown?.();
      await teamChatBridge?.stop();
      await stopInstalledBridges?.();
    },
  };
}
