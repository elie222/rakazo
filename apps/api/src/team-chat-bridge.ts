import type {
  JobPublisher,
  MessagingInboundAttachment,
  TeamChatInboundMessage,
  TeamChatSendRequest,
  TeamChatSendResult,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  botMessageMaxHops,
  messageBlockForArtifact,
  promptTextForAttachments,
  teamChatPrompt,
  teamChatResponseText,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { clearEndedRunState, teamChatRunClientNonce } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { storeInboundAttachments } from "./inbound-attachments.js";
import type { MessagingReceipts } from "./messaging-receipts.js";
import { TeamChatAmbient } from "./team-chat-ambient.js";
import { TeamChatDelivery } from "./team-chat-delivery.js";
import type { TeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  MESSAGE_ROUTING_REARMED_REASON,
  MESSAGE_ROUTING_REASON,
  MESSAGE_ROUTING_RESERVATION_MS,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
  TEAMCHAT_AGENT_OWNERSHIP_REASON,
} from "./team-chat-startup.js";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./webhook-inbound.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 1_000;
const BATCH_SIZE = 20;
const DEFERRED_RESERVATION_MS = 2 * 60_000;
/** Hold the deferred row while routine routing may still be writing its wake nonce. */
const ROUTING_RESERVATION_MS = MESSAGE_ROUTING_RESERVATION_MS;
const ROUTING_RESERVATION_RENEWAL_MS = 60_000;
const QUEUE_RESERVATION_MS = 2 * 60_000;
const ROUTING_OWNERSHIP_REASON = MESSAGE_ROUTING_REASON;
/** Legacy grace marker; still exclusive ownership, never promote while set. */
const ROUTING_OWNERSHIP_REARMED_REASON = MESSAGE_ROUTING_REARMED_REASON;
const AGENT_OWNERSHIP_REASON = TEAMCHAT_AGENT_OWNERSHIP_REASON;
const DEFERRED_RESERVATION_LOST = "Team chat deferred reservation was lost";

export function isDeferredReservationLost(error: unknown): boolean {
  return error instanceof Error && error.message === DEFERRED_RESERVATION_LOST;
}

function isRoutingOwnershipReason(reason: string | null | undefined): boolean {
  return reason === ROUTING_OWNERSHIP_REASON || reason === ROUTING_OWNERSHIP_REARMED_REASON;
}

export interface TeamChatBridgeDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage">;
  jobs: Pick<JobPublisher, "enqueue">;
  send: (request: TeamChatSendRequest) => Promise<TeamChatSendResult>;
  fetchThreadHistory?: (message: TeamChatInboundMessage) => Promise<TeamChatInboundMessage[]>;
  storeAttachment?: InboundAttachmentStore;
  providerId: string;
  botId: string;
  workspaceId?: string;
  isAvailable?: () => Promise<boolean>;
  conversationPrefix?: string;
  onUnavailable?: () => void;
  judge?: TeamChatEngagementJudge;
  acknowledge?: MessagingReceipts["acknowledge"];
  reconcileIntervalMs?: number;
  ambientDebounceMs?: number;
}

export type TargetBot = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  modelProvider: string | null;
  modelId: string | null;
};

export type TeamChatInboundTarget = {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
};

type DeferredTeamChatInboundTarget = TeamChatInboundTarget & {
  deferred: boolean;
  externalMessageId: string;
};

function readBatchContext(
  value: string | null,
): { prompt: string; messageIds: string[] } | undefined {
  if (!value) return undefined;
  try {
    const batch: unknown = JSON.parse(value);
    if (
      batch !== null &&
      typeof batch === "object" &&
      "prompt" in batch &&
      typeof batch.prompt === "string" &&
      "messageIds" in batch &&
      Array.isArray(batch.messageIds) &&
      batch.messageIds.every((id): id is string => typeof id === "string")
    )
      return { prompt: batch.prompt, messageIds: batch.messageIds };
  } catch {
    // Previously persisted batches contain only the plain prompt.
  }
  return { prompt: value, messageIds: [] };
}

export class TeamChatBridge {
  private readonly threadBackfills = new Map<string, Promise<void>>();
  private target: TargetBot | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconciling: Promise<void> | undefined;
  /** Bumped by stop() so an in-flight start() exits before arming the timer. */
  private startGeneration = 0;
  /** Same-process wakes still delivering; do not treat their expired leases as orphans. */
  private readonly inFlightRoutineWakes = new Set<string>();
  private readonly mirroring = new Map<string, Promise<void>>();
  private readonly receiving = new Map<string, number>();

  private readonly ambient: TeamChatAmbient;
  private readonly delivery: TeamChatDelivery;

  constructor(private readonly deps: TeamChatBridgeDeps) {
    this.ambient = new TeamChatAmbient(
      deps,
      () => this.target,
      () => this.conversationScope(),
    );
    this.delivery = new TeamChatDelivery(deps, () => this.target);
  }

  /** Provider used for ExternalConversation rows and wake clientNonce recovery. */
  get providerId(): string {
    return this.deps.providerId;
  }

  /** Mark a deferred row as having an in-process routine wake until clearRoutineWake. */
  markRoutineWakeInFlight(externalMessageId: string): void {
    this.inFlightRoutineWakes.add(externalMessageId);
  }

  clearRoutineWakeInFlight(externalMessageId: string): void {
    this.inFlightRoutineWakes.delete(externalMessageId);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const generation = ++this.startGeneration;
    const throwIfStopped = () => {
      if (generation !== this.startGeneration) {
        throw new Error("Team chat bridge start cancelled");
      }
    };
    const target = await this.deps.prisma.bot.findFirst({
      where: { id: this.deps.botId, archivedAt: null },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        name: true,
        modelProvider: true,
        modelId: true,
      },
    });
    throwIfStopped();
    if (!target) throw new Error(`Team chat target bot ${this.deps.botId} was not found`);
    this.target = target;
    // Release abandoned routes before any later setup that might throw and leave
    // start() unfinished (for example transcript mirroring).
    await this.recoverInterruptedRoutineRoutes(target);
    throwIfStopped();
    await this.mirrorMissingMessages();
    throwIfStopped();
    await this.reconcileOnce();
    throwIfStopped();
    this.timer = setInterval(
      () => void this.reconcileSafely(),
      this.deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    // Invalidate any in-flight start() so later startup phases abort.
    this.startGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Do not let a blocked reconcileOnce from start() hang process shutdown.
    await settleWithTimeout(this.reconciling, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
  }

  async receive(
    message: TeamChatInboundMessage,
    options: { queueAgent: false },
  ): Promise<DeferredTeamChatInboundTarget>;
  async receive(
    message: TeamChatInboundMessage,
    options?: { queueAgent?: true },
  ): Promise<TeamChatInboundTarget>;
  async receive(
    message: TeamChatInboundMessage,
    options?: { queueAgent?: boolean },
  ): Promise<TeamChatInboundTarget | DeferredTeamChatInboundTarget> {
    const release = this.reserveInboundEvent(message.eventId);
    try {
      return await this.receiveMessage(message, options);
    } finally {
      release();
    }
  }

  private reserveInboundEvent(eventId: string): () => void {
    this.receiving.set(eventId, (this.receiving.get(eventId) ?? 0) + 1);
    return () => {
      const remaining = (this.receiving.get(eventId) ?? 1) - 1;
      if (remaining) this.receiving.set(eventId, remaining);
      else this.receiving.delete(eventId);
    };
  }

  private conversationScope() {
    return {
      provider: this.deps.providerId,
      botId: this.deps.botId,
      ...(this.deps.workspaceId ? { workspaceId: this.deps.workspaceId } : {}),
      conversationId: this.deps.conversationPrefix
        ? { startsWith: this.deps.conversationPrefix }
        : { not: { startsWith: `${this.deps.providerId}~` } },
    };
  }

  private async receiveMessage(
    message: TeamChatInboundMessage,
    options?: { queueAgent?: boolean },
  ): Promise<TeamChatInboundTarget | DeferredTeamChatInboundTarget> {
    if (this.deps.workspaceId && message.workspaceId !== this.deps.workspaceId)
      throw new Error("Messaging workspace mismatch");
    if (this.deps.isAvailable && !(await this.deps.isAvailable()))
      throw new Error("Messaging workspace unavailable");
    await this.backfillThreadHistory(message);
    const conversation = await this.upsertConversation(message);
    const now = new Date();
    const deferredUntil = new Date(now.getTime() + DEFERRED_RESERVATION_MS);
    const status =
      options?.queueAgent === false
        ? "deferred"
        : message.kind === "ambient"
          ? "observed"
          : "received";
    const nextAttemptAt = options?.queueAgent === false ? deferredUntil : null;
    let externalMessage = await this.deps.prisma.externalMessage.upsert({
      where: {
        externalConversationId_providerEventId: {
          externalConversationId: conversation.id,
          providerEventId: message.eventId,
        },
      },
      create: {
        externalConversationId: conversation.id,
        providerEventId: message.eventId,
        kind: message.kind,
        senderId: message.senderId,
        senderName: message.senderName,
        senderIsBot: message.senderIsBot ?? false,
        content: message.content,
        replyThreadId: message.replyThreadId,
        status,
        nextAttemptAt,
      },
      update: {},
    });
    // A concurrent backfill can record this live message as history first.
    if (externalMessage.engagementReason === "thread_history") {
      externalMessage = await this.deps.prisma.externalMessage.update({
        where: { id: externalMessage.id },
        data: { kind: message.kind, status, nextAttemptAt, engagementReason: null, judgedAt: null },
      });
    }
    if (message.kind !== "ambient") {
      const externalMessageId = externalMessage.id;
      this.deps.acknowledge?.(message.conversationId, message.eventId, async () => {
        const row = await this.deps.prisma.externalMessage.findUnique({
          where: { id: externalMessageId },
          select: { deliveredAt: true, status: true },
        });
        return (
          Boolean(row?.deliveredAt) || row?.status === "ignored" || row?.status === "cancelled"
        );
      });
    }
    await this.ensureTranscriptMessage(externalMessage, conversation, message.attachments ?? []);
    if (options?.queueAgent === false) {
      const deferred =
        (externalMessage.status === "deferred" &&
          externalMessage.nextAttemptAt?.getTime() === deferredUntil.getTime()) ||
        (
          await this.deps.prisma.externalMessage.updateMany({
            where: {
              id: externalMessage.id,
              OR: [
                { status: { in: ["received", "observed"] } },
                { status: "deferred", nextAttemptAt: { lte: now } },
              ],
            },
            data: { status: "deferred", nextAttemptAt: deferredUntil },
          })
        ).count === 1;
      return {
        spaceId: conversation.spaceId,
        userId: conversation.userId,
        botId: conversation.botId,
        threadId: conversation.thread.id,
        deferred,
        externalMessageId: externalMessage.id,
      };
    }
    await this.reconcileOnce();
    return {
      spaceId: conversation.spaceId,
      userId: conversation.userId,
      botId: conversation.botId,
      threadId: conversation.thread.id,
    };
  }

  private async backfillThreadHistory(message: TeamChatInboundMessage): Promise<void> {
    if (!message.replyThreadId) return;
    const key = JSON.stringify([
      this.deps.providerId,
      message.workspaceId,
      message.conversationKey,
      message.replyThreadId,
    ]);
    const pending = this.threadBackfills.get(key);
    if (pending) return pending;
    const fetchThreadHistory = this.deps.fetchThreadHistory;
    if (!fetchThreadHistory || message.kind === "ambient") return;
    const backfill = (async () => {
      if (await this.knowsReplyThread(message)) return;
      const downloadDeadline = Date.now() + 2_000;
      try {
        await this.receiveHistory(await fetchThreadHistory(message), downloadDeadline);
      } catch (error) {
        getLogger().warn("team chat thread history was not loaded", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.threadBackfills.set(key, backfill);
    try {
      await backfill;
    } finally {
      this.threadBackfills.delete(key);
    }
  }

  private async knowsReplyThread(message: TeamChatInboundMessage): Promise<boolean> {
    const replyThreadId = message.replyThreadId;
    if (!replyThreadId || replyThreadId === message.eventId) return true;
    const known = await this.deps.prisma.externalMessage.findFirst({
      where: {
        OR: [{ providerEventId: replyThreadId }, { replyThreadId }],
        externalConversation: {
          provider: this.deps.providerId,
          workspaceId: message.workspaceId,
          externalKey: message.conversationKey,
        },
      },
      select: { id: true },
    });
    return known !== null;
  }

  private async receiveHistory(
    messages: TeamChatInboundMessage[],
    downloadDeadline: number,
  ): Promise<void> {
    const first = messages[0];
    if (!first) return;
    const releases = messages.map((message) => this.reserveInboundEvent(message.eventId));
    try {
      const conversation = await this.upsertConversation(first);
      const fileLimits = newestFirstFileLimits(messages, ATTACHMENT_MAX_COUNT);
      for (const [index, message] of messages.entries()) {
        const externalMessage = await this.deps.prisma.externalMessage.upsert({
          where: {
            externalConversationId_providerEventId: {
              externalConversationId: conversation.id,
              providerEventId: message.eventId,
            },
          },
          create: {
            externalConversationId: conversation.id,
            providerEventId: message.eventId,
            kind: message.kind,
            senderId: message.senderId,
            senderName: message.senderName,
            senderIsBot: message.senderIsBot ?? false,
            content: message.content,
            replyThreadId: message.replyThreadId,
            status: "ignored",
            engagementReason: "thread_history",
            judgedAt: new Date(),
          },
          update: {},
        });
        await this.ensureTranscriptMessage(
          externalMessage,
          conversation,
          message.attachments ?? [],
          fileLimits[index],
          downloadDeadline,
        );
      }
    } finally {
      for (const release of releases) release();
    }
  }

  private async upsertConversation(message: TeamChatInboundMessage) {
    const target = this.target;
    if (!target) throw new Error("Team chat bridge is not started");
    const conversation = await this.deps.prisma.externalConversation.upsert({
      where: {
        spaceId: target.spaceId,
        botId: target.id,
        provider_workspaceId_externalKey: {
          provider: this.deps.providerId,
          workspaceId: message.workspaceId,
          externalKey: message.conversationKey,
        },
      },
      create: {
        provider: this.deps.providerId,
        workspaceId: message.workspaceId,
        externalKey: message.conversationKey,
        conversationId: message.conversationId,
        displayName: message.conversationName,
        participantNames: message.participantNames ?? [],
        spaceId: target.spaceId,
        botId: target.id,
        userId: target.userId,
        thread: { create: { spaceId: target.spaceId, userId: target.userId } },
      },
      update: {
        conversationId: message.conversationId,
        ...(message.conversationName ? { displayName: message.conversationName } : {}),
        ...(message.participantNames?.length ? { participantNames: message.participantNames } : {}),
      },
      include: { thread: { select: { id: true } } },
    });
    if (
      conversation.botId !== target.id ||
      conversation.spaceId !== target.spaceId ||
      !conversation.thread
    ) {
      throw new Error("Team chat conversation belongs to a different Rakazo target");
    }
    return { ...conversation, thread: conversation.thread };
  }

  /** Keep a deferred lease alive while routine routing is still in progress. */
  async extendDeferredReservation(externalMessageId: string): Promise<boolean> {
    const target = this.target;
    if (!target) return false;
    const result = await this.deps.prisma.externalMessage.updateMany({
      where: {
        id: externalMessageId,
        status: "deferred",
        externalConversation: this.conversationScope(),
      },
      // Routing can outlive the short deferred window; hold long enough for the
      // wake nonce to commit before reconcile is allowed to promote the row.
      // engagementReason marks exclusive routine ownership for recovery/queue.
      data: {
        nextAttemptAt: new Date(Date.now() + ROUTING_RESERVATION_MS),
        engagementReason: ROUTING_OWNERSHIP_REASON,
      },
    });
    return result.count === 1;
  }

  /** Refresh the deferred lease until the caller stops the heartbeat after routing settles. */
  async startDeferredReservationHeartbeat(
    externalMessageId: string,
    intervalMs = ROUTING_RESERVATION_RENEWAL_MS,
  ): Promise<{ stop: () => void; lost: Promise<never> }> {
    if (!(await this.extendDeferredReservation(externalMessageId))) {
      throw new Error(DEFERRED_RESERVATION_LOST);
    }
    let active = true;
    let renewing = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let rejectLost: ((error: Error) => void) | undefined;
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });
    // Prevent an unhandled rejection if the caller stops before awaiting lost.
    void lost.catch(() => undefined);
    const fail = (error: Error) => {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      rejectLost?.(error);
    };
    timer = setInterval(() => {
      if (!active || renewing) return;
      renewing = true;
      void this.extendDeferredReservation(externalMessageId)
        .then((held) => {
          if (!held) fail(new Error(DEFERRED_RESERVATION_LOST));
        })
        .catch((error) => {
          getLogger().error("team chat deferred reservation renewal failed", error);
          fail(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          renewing = false;
        });
    }, intervalMs);
    timer.unref?.();
    return {
      stop: () => {
        active = false;
        if (timer) clearInterval(timer);
      },
      lost,
    };
  }

  /**
   * Resolve a deferred message before the reconciler is allowed to claim it.
   * Routine ownership may also reclaim `received` / `observed` rows when the
   * deferred lease expired mid-wake before this resolve ran. Do not reclaim
   * `queueing`: that status means fallback delivery may already be creating a
   * TeamChat run, and flipping it to ignored races that path.
   */
  async resolveDeferredMessage(
    externalMessageId: string,
    resolution: "routine" | "agent" | "ignored",
    kind: TeamChatInboundMessage["kind"],
  ): Promise<boolean> {
    const target = this.target;
    if (!target) return false;
    const result = await this.deps.prisma.externalMessage.updateMany({
      where: {
        id: externalMessageId,
        // A routine or a refusal settles a row recovery already handed back to agent routing too;
        // work the agent started (queueing, running) stays its own.
        status: resolution === "agent" ? "deferred" : { in: ["deferred", "received", "observed"] },
        externalConversation: this.conversationScope(),
      },
      data:
        resolution === "routine"
          ? {
              status: "ignored",
              engagementReason: "message_routine_wake",
              nextAttemptAt: null,
            }
          : resolution === "ignored"
            ? // Nobody answers it; its transcript copy stays.
              { status: "ignored", engagementReason: null, nextAttemptAt: null }
            : {
                status: kind === "ambient" ? "observed" : "received",
                engagementReason: null,
                nextAttemptAt: null,
              },
    });
    return result.count === 1;
  }

  private async mirrorMissingMessages(): Promise<void> {
    const target = this.target;
    if (!target) return;
    while (true) {
      const messages = await this.deps.prisma.externalMessage.findMany({
        where: {
          threadMessageId: null,
          id: { notIn: [...this.mirroring.keys()] },
          providerEventId: { notIn: [...this.receiving.keys()] },
          externalConversation: {
            ...this.conversationScope(),
            spaceId: target.spaceId,
          },
        },
        include: {
          externalConversation: {
            include: { thread: { select: { id: true } } },
          },
        },
        orderBy: { createdAt: "asc" },
        take: BATCH_SIZE,
      });
      if (messages.length === 0) return;
      for (const message of messages) {
        if (this.receiving.has(message.providerEventId)) continue;
        await this.ensureTranscriptMessage(message, message.externalConversation);
      }
    }
  }

  /**
   * Release expired routing ownership left by a stopped process before
   * reconciliation starts. Active claims (future nextAttemptAt) stay owned by a
   * live wake on another bridge instance.
   */
  private async recoverInterruptedRoutineRoutes(target: TargetBot): Promise<void> {
    const now = new Date();
    await this.deps.prisma.externalMessage.updateMany({
      where: {
        status: "deferred",
        engagementReason: {
          in: [ROUTING_OWNERSHIP_REASON, ROUTING_OWNERSHIP_REARMED_REASON],
        },
        nextAttemptAt: { lte: now },
        externalConversation: {
          ...this.conversationScope(),
          spaceId: target.spaceId,
        },
      },
      data: { engagementReason: null, nextAttemptAt: now },
    });
  }

  private async ensureTranscriptMessage(
    message: {
      id: string;
      providerEventId: string;
      senderName: string;
      content: string;
      threadMessageId: string | null;
    },
    conversation: {
      spaceId: string;
      botId: string;
      userId: string;
      thread: { id: string } | null;
    },
    attachments?: MessagingInboundAttachment[],
    fileLimit = ATTACHMENT_MAX_COUNT,
    downloadDeadline?: number,
  ): Promise<void> {
    if (message.threadMessageId) return;
    const pending = this.mirroring.get(message.id);
    if (pending) return pending;
    const mirroring = (async () => {
      if (!conversation.thread) throw new Error("Team chat conversation has no Rakazo thread");
      // Fetchers cannot survive a restart; reuse any completed per-file uploads.
      const stored = attachments
        ? await storeInboundAttachments(this.deps.storeAttachment, conversation, attachments, {
            clientNonce: (index) => `teamchat-attachment:${message.id}:${index}`,
            limit: fileLimit,
            downloadDeadline,
          }).then(({ stored, unavailable }) => ({
            artifacts: stored.map(({ artifact }) => artifact),
            unavailable,
          }))
        : {
            artifacts: await this.deps.prisma.artifact.findMany({
              where: {
                spaceId: conversation.spaceId,
                userId: conversation.userId,
                botId: conversation.botId,
                groupId: null,
                clientNonce: {
                  in: Array.from(
                    { length: ATTACHMENT_MAX_COUNT },
                    (_, index) => `teamchat-attachment:${message.id}:${index}`,
                  ),
                },
              },
              select: { id: true, name: true, mimeType: true, size: true },
              orderBy: { clientNonce: "asc" },
            }),
            unavailable: [],
          };
      const text =
        [message.content.trim(), ...stored.unavailable].filter(Boolean).join("\n") ||
        (stored.artifacts.length ? "" : "[file (unavailable)]");
      const visible = await this.deps.events.sendUserMessage({
        spaceId: conversation.spaceId,
        threadId: conversation.thread.id,
        botId: conversation.botId,
        userId: conversation.userId,
        blocks: [
          ...(text ? [{ kind: "text" as const, text }] : []),
          ...stored.artifacts.map((artifact) => messageBlockForArtifact(artifact)),
        ],
        prompt: promptTextForAttachments(text, stored.artifacts),
        trigger: "messaging",
        clientNonce: `teamchat-transcript:${this.deps.providerId}:${message.providerEventId}`,
        createRun: false,
      });
      await this.deps.prisma.externalMessage.update({
        where: { id: message.id },
        data: { threadMessageId: visible.messageId },
      });
    })().finally(() => this.mirroring.delete(message.id));
    this.mirroring.set(message.id, mirroring);
    return mirroring;
  }

  /**
   * Promote expired deferred leases. If a routine run was already persisted (crash before
   * resolveDeferredMessage), mark the row ignored so recovery cannot also start a TeamChat
   * agent run for the same provider event. Expired routing ownership is cleared, not promoted.
   */
  private async recoverExpiredDeferredMessages(target: TargetBot, now: Date): Promise<void> {
    const expired = await this.deps.prisma.externalMessage.findMany({
      where: {
        status: "deferred",
        nextAttemptAt: { lte: now },
        externalConversation: {
          ...this.conversationScope(),
        },
      },
      select: {
        id: true,
        kind: true,
        providerEventId: true,
        engagementReason: true,
        nextAttemptAt: true,
        externalConversation: { select: { thread: { select: { id: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const message of expired) {
      const threadId = message.externalConversation.thread?.id;
      const woken = threadId
        ? await this.deps.prisma.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId,
                clientNonce: inboundDeliveryClientNonce(
                  "messaging",
                  target.id,
                  messagingWakeIdempotencyKey(this.deps.providerId, message.providerEventId),
                ),
              },
            },
            select: { id: true },
          })
        : null;
      if (woken) {
        await this.deps.prisma.externalMessage.updateMany({
          where: { id: message.id, status: "deferred", nextAttemptAt: { lte: now } },
          data: {
            status: "ignored",
            engagementReason: "message_routine_wake",
            nextAttemptAt: null,
          },
        });
        continue;
      }
      if (isRoutingOwnershipReason(message.engagementReason)) {
        if (this.inFlightRoutineWakes.has(message.id)) {
          // Same-process wake still delivering; keep exclusive ownership.
          continue;
        }
        // Lease expired and no local wake: drop orphaned ownership so a later reconcile can promote.
        await this.deps.prisma.externalMessage.updateMany({
          where: {
            id: message.id,
            status: "deferred",
            nextAttemptAt: { lte: now },
            engagementReason: {
              in: [ROUTING_OWNERSHIP_REASON, ROUTING_OWNERSHIP_REARMED_REASON],
            },
          },
          data: { engagementReason: null, nextAttemptAt: now },
        });
        continue;
      }
      // Promote when free of ownership claims. Ambient judge text is not ownership.
      await this.deps.prisma.externalMessage.updateMany({
        where: {
          id: message.id,
          status: "deferred",
          nextAttemptAt: { lte: now },
          OR: [
            { engagementReason: null },
            {
              NOT: {
                engagementReason: {
                  in: [
                    ROUTING_OWNERSHIP_REASON,
                    ROUTING_OWNERSHIP_REARMED_REASON,
                    AGENT_OWNERSHIP_REASON,
                  ],
                },
              },
            },
          ],
        },
        data: {
          status: message.kind === "ambient" ? "observed" : "received",
          engagementReason: null,
          nextAttemptAt: null,
        },
      });
    }
  }

  async reconcileOnce(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcile().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcile(): Promise<void> {
    const target = this.target;
    if (!target) return;
    if (this.deps.isAvailable && !(await this.deps.isAvailable())) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.startGeneration += 1;
      this.deps.onUnavailable?.();
      return;
    }
    const now = new Date();
    await this.mirrorMissingMessages();
    await this.recoverExpiredDeferredMessages(target, now);
    await this.deps.prisma.externalMessage.updateMany({
      where: {
        status: "queueing",
        nextAttemptAt: { lte: now },
        externalConversation: {
          ...this.conversationScope(),
        },
      },
      data: { status: "received", engagementReason: null, nextAttemptAt: null },
    });
    await this.ambient.evaluateAmbient(now);
    const received = await this.deps.prisma.externalMessage.findMany({
      where: {
        status: "received",
        threadMessageId: { not: null },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        externalConversation: {
          ...this.conversationScope(),
        },
      },
      include: {
        externalConversation: { include: { thread: { select: { id: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const message of received)
      await this.queue(message).catch((error) => this.retry(message, error));

    const running = await this.deps.prisma.externalMessage.findMany({
      where: {
        status: { in: ["running", "delivering"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        externalConversation: {
          ...this.conversationScope(),
        },
      },
      include: { run: true, externalConversation: true },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const message of running) {
      if (message.run?.status === "completed") {
        await this.delivery.deliverCompletion(message).catch((error) => this.retry(message, error));
      } else if (message.run?.status === "failed" || message.run?.status === "cancelled") {
        await this.delivery.deliverFailure(message).catch((error) => this.retry(message, error));
      }
    }
    await this.deliverDelegatedReplies(target);
  }

  private async deliverDelegatedReplies(target: TargetBot): Promise<void> {
    const runs = await this.deps.prisma.run.findMany({
      where: {
        botId: target.id,
        trigger: "bot_message",
        status: { in: ["completed", "failed"] },
        teamChatMirroredAt: null,
        thread: {
          externalConversation: {
            ...this.conversationScope(),
          },
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
      select: {
        id: true,
        status: true,
        sourceMessageId: true,
      },
    });
    for (const run of runs) {
      const origin = await this.findExternalOrigin(run.sourceMessageId);
      if (!origin) {
        await this.markTeamChatMirrored(run.id);
        continue;
      }
      const response =
        run.status === "completed"
          ? await this.deps.prisma.message.findFirst({
              where: { runId: run.id, role: "bot" },
              orderBy: { seq: "desc" },
              select: { blocks: true },
            })
          : null;
      const blocks = Array.isArray(response?.blocks) ? (response.blocks as MessageBlock[]) : [];
      const content =
        run.status === "failed"
          ? `${target.name} could not complete the delegated request. Open Rakazo for details.`
          : teamChatResponseText(blocks, target.name, true);
      if (content) {
        await this.deps.send({
          conversationId: origin.externalConversation.conversationId,
          replyThreadId: origin.replyThreadId,
          content,
          idempotencyKey: `team-chat-run:${run.id}`,
        });
      }
      await this.markTeamChatMirrored(run.id);
    }
  }

  private async findExternalOrigin(sourceMessageId: string | null) {
    let currentSourceMessageId: string | null = sourceMessageId;
    const visitedRunIds = new Set<string>();
    const maxHops = botMessageMaxHops();
    for (let depth = 0; currentSourceMessageId && depth <= maxHops; depth += 1) {
      const source = await this.deps.prisma.message.findUnique({
        where: { id: currentSourceMessageId },
        select: { replyTo: { select: { runId: true } } },
      });
      const parentRunId = source?.replyTo?.runId;
      if (!parentRunId || visitedRunIds.has(parentRunId)) return null;
      visitedRunIds.add(parentRunId);
      const external = await this.deps.prisma.externalMessage.findUnique({
        where: { runId: parentRunId },
        select: {
          replyThreadId: true,
          externalConversation: { select: { conversationId: true } },
        },
      });
      if (external) return external;
      const parent = await this.deps.prisma.run.findUnique({
        where: { id: parentRunId },
        select: { sourceMessageId: true },
      });
      currentSourceMessageId = parent?.sourceMessageId ?? null;
    }
    return null;
  }

  private async markTeamChatMirrored(runId: string): Promise<void> {
    await this.deps.prisma.run.updateMany({
      where: { id: runId, teamChatMirroredAt: null },
      data: { teamChatMirroredAt: new Date() },
    });
  }

  private async queue(message: {
    id: string;
    providerEventId: string;
    senderId: string;
    senderName: string;
    content: string;
    batchContext: string | null;
    engagementReason?: string | null;
    externalConversation: {
      spaceId: string;
      botId: string;
      userId: string;
      thread: { id: string } | null;
    };
  }): Promise<void> {
    const thread = message.externalConversation.thread;
    if (!thread) throw new Error("Team chat conversation has no Rakazo thread");
    // In-flight routine wakes own the row via engagementReason; never start a
    // fallback TeamChat agent until that claim is cleared.
    if (isRoutingOwnershipReason(message.engagementReason)) {
      return;
    }
    const wakeNonce = inboundDeliveryClientNonce(
      "messaging",
      message.externalConversation.botId,
      messagingWakeIdempotencyKey(this.deps.providerId, message.providerEventId),
    );
    const findWake = () =>
      this.deps.prisma.message.findUnique({
        where: {
          threadId_clientNonce: {
            threadId: thread.id,
            clientNonce: wakeNonce,
          },
        },
        select: { id: true },
      });
    const abandonForRoutine = async (status: "received" | "queueing") => {
      await this.deps.prisma.externalMessage.updateMany({
        where: {
          id: message.id,
          status,
          ...(status === "queueing" ? { runId: null } : {}),
        },
        data: {
          status: "ignored",
          engagementReason: "message_routine_wake",
          nextAttemptAt: null,
        },
      });
    };
    // Lease recovery may have promoted this row before wake finished. If the
    // messaging routine nonce now exists, do not start a fallback agent run.
    if (await findWake()) {
      await abandonForRoutine("received");
      return;
    }
    // Atomically claim queueing + exclusive agent ownership before creating a
    // run so a concurrent wake cannot also deliver for this provider event.
    // Allow null or non-ownership reasons (e.g. ambient judge text); refuse when
    // routing ownership was reasserted by an in-flight wake.
    const claimed = await this.deps.prisma.externalMessage.updateMany({
      where: {
        id: message.id,
        status: "received",
        OR: [
          { engagementReason: null },
          {
            NOT: {
              engagementReason: {
                in: [
                  ROUTING_OWNERSHIP_REASON,
                  ROUTING_OWNERSHIP_REARMED_REASON,
                  AGENT_OWNERSHIP_REASON,
                ],
              },
            },
          },
        ],
      },
      data: {
        status: "queueing",
        engagementReason: AGENT_OWNERSHIP_REASON,
        nextAttemptAt: new Date(Date.now() + QUEUE_RESERVATION_MS),
      },
    });
    if (claimed.count !== 1) return;
    // Wake may commit between the pre-claim check and this reservation.
    if (await findWake()) {
      await abandonForRoutine("queueing");
      return;
    }
    // Final pre-create barrier: refuse if routing ownership reappeared.
    const latest = await this.deps.prisma.externalMessage.findUnique({
      where: { id: message.id },
      select: { status: true, engagementReason: true },
    });
    if (
      latest?.status !== "queueing" ||
      latest.engagementReason !== AGENT_OWNERSHIP_REASON ||
      (await findWake())
    ) {
      await abandonForRoutine("queueing");
      return;
    }
    const batch = readBatchContext(message.batchContext);
    const prompt =
      batch?.prompt ?? teamChatPrompt(this.deps.providerId, message.senderName, message.content);
    const transcripts = await this.deps.prisma.message.findMany({
      where: {
        threadId: thread.id,
        externalTranscriptFor: {
          id: { in: batch?.messageIds.length ? batch.messageIds : [message.id] },
        },
      },
      select: { blocks: true },
      orderBy: { seq: "asc" },
    });
    const fileBlocks = transcripts
      .flatMap(({ blocks }) =>
        (blocks as MessageBlock[]).filter(
          (block) => block.kind === "file" || block.kind === "image",
        ),
      )
      .slice(-ATTACHMENT_MAX_COUNT);
    const sent = await this.deps.events.sendUserMessage({
      spaceId: message.externalConversation.spaceId,
      threadId: thread.id,
      botId: message.externalConversation.botId,
      userId: message.externalConversation.userId,
      blocks: [{ kind: "text", text: prompt }, ...fileBlocks],
      prompt,
      trigger: "messaging",
      clientNonce: teamChatRunClientNonce(this.deps.providerId, message.providerEventId),
      linkMessageToRun: true,
      allowParallelRun: true,
    });
    // Routine wake may have committed during sendUserMessage. Cancel the
    // fallback run before abandoning so the job reconciler cannot enqueue it
    // beside the routine wake.
    if (await findWake()) {
      if (sent.runId) {
        const cancelledAt = new Date();
        await this.deps.prisma.run.updateMany({
          where: {
            id: sent.runId,
            status: { in: ["queued", "running", "leased", "waiting_input", "waiting_takeover"] },
          },
          data: {
            status: "cancelled",
            completedAt: cancelledAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await clearEndedRunState(this.deps.prisma, [sent.runId]);
        const taskId =
          sent.taskId ??
          (
            await this.deps.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { taskId: true },
            })
          )?.taskId;
        if (taskId) {
          await this.deps.prisma.task.updateMany({
            where: { id: taskId },
            data: { status: "cancelled" },
          });
        }
      }
      await abandonForRoutine("queueing");
      return;
    }
    if (!sent.runId) throw new Error("Team chat message did not create an agent run");
    const linked = await this.deps.prisma.externalMessage.updateMany({
      where: {
        id: message.id,
        status: "queueing",
        engagementReason: AGENT_OWNERSHIP_REASON,
      },
      data: {
        status: "running",
        runId: sent.runId,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    if (linked.count !== 1) throw new Error("Team chat queue reservation was lost");
    await this.deps.jobs.enqueue(runContinueJob(sent.runId));
  }

  private async retry(message: { id: string; status: string; attempts: number }, error: unknown) {
    const attempts = message.attempts + 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
    const current = await this.deps.prisma.externalMessage.findUnique({
      where: { id: message.id },
      select: { status: true, providerReplyHandle: true },
    });
    if (!current) return;
    // A concurrent reserveDelivery may have finalized with "unconfirmed". Do not
    // clear that lost-confirmation metadata via markDelivered.
    if (current.providerReplyHandle) {
      if (current.status !== "delivered") {
        await this.delivery.markDelivered(message.id, current.providerReplyHandle);
      }
      return;
    }
    if (current.status === "delivered") return;
    // Restoring the pre-reserve status would let reconciliation send again after a lost ack.
    // Queueing failed before the run was linked, so it can retry from received; once linked,
    // keep running so the run reconciler recovers it without a second message/run.
    const status = current.status === "queueing" ? "received" : current.status;
    // Conditional write: if reserveDelivery finalized between the read and this
    // update, leave the delivered/unconfirmed row alone.
    await this.deps.prisma.externalMessage.updateMany({
      where: {
        id: message.id,
        providerReplyHandle: null,
        status: current.status,
      },
      data: {
        status,
        ...(current.status === "queueing" ? { engagementReason: null } : {}),
        attempts,
        lastError: error instanceof Error ? error.message.slice(0, 500) : "Unknown bridge error",
        nextAttemptAt: new Date(Date.now() + delay),
      },
    });
  }

  private async reconcileSafely(): Promise<void> {
    await this.reconcileOnce().catch((error) => {
      getLogger().error("team chat reconciliation error", error);
    });
  }
}

/** Splits a file budget across messages, giving the newest ones their files first. */
function newestFirstFileLimits(
  messages: ReadonlyArray<{ attachments?: readonly unknown[] }>,
  budget: number,
): number[] {
  let remaining = budget;
  return messages
    .toReversed()
    .map((message) => {
      const limit = Math.min(message.attachments?.length ?? 0, remaining);
      remaining -= limit;
      return limit;
    })
    .toReversed();
}
