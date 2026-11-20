import type {
  JobPublisher,
  JobQueueOrder,
  MessagingInboundMessage,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  MESSAGING_INBOUND_SETTLE_MAX_ATTACHMENTS,
  messagingInboundSettleJobKey,
  messagingInboundSettleQueue,
  teamChatEngageJobKey,
} from "@rakazo/adapter-kit";
import type { MessagingDelivery, OutboundLane } from "@rakazo/adapters";
import {
  filesNotReceivedReply,
  inboundArrivalTime,
  MESSAGING_DM_OUTBOUND_CAP,
  messagingAttachmentClientNonce,
  messagingMessageClientNonce,
  messagingWakeIdempotencyKey,
  ownerStopKey,
  sealSettleText,
  stoppedSince,
  wakeRun,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, isAttachmentAudioMimeType } from "@rakazo/contracts";
import type { MessagingCommand } from "@rakazo/core";
import {
  abortableDelay,
  displayName,
  messageBlockForArtifact,
  normalizeVoiceTranscript,
  parseMessagingCommand,
  promptTextForAttachments,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type {
  MessagingIdentityRequest,
  Prisma,
  PrismaClient,
  ProvisionedMessagingIdentity,
  ThreadEvents,
} from "@rakazo/db";
import {
  accountDeactivated,
  createThreadMessage,
  crossSpaceCommunicationAllowed,
  normalizeMessagingLinkCode,
  redeemMessagingLinkCode,
  SendClaimLostError,
  SpaceDeletionInProgressError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import {
  cancelThreadRuns,
  finishThreadStop,
  STOPPED_BY_MESSAGE_NOTE,
} from "../threads/thread-stop.js";
import { deliverWebhookEvent } from "../webhooks/webhook-inbound.js";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { storeInboundAttachments } from "./inbound-attachments.js";
import { formatMessagingEventPrompt } from "./inbound-delivery.prompt.js";
import {
  DIRECT_ATTACHMENT_ATTEMPTS,
  DIRECT_ATTACHMENT_TIMEOUT_MS,
  DIRECT_MESSAGE_SETTLE_BUDGET_MS,
  SHUTDOWN_DOWNLOAD_GRACE_MS,
  SHUTDOWN_HANDOFF_MARGIN_MS,
} from "./intake/limits.js";
import type { SenderQueue } from "./intake/sender-queue.js";
import { createSenderQueue } from "./intake/sender-queue.js";
import type { SettlePayload } from "./intake/settle-job.js";
import {
  cancelSettleJob,
  recordSettleJob,
  settleJobAt,
  settleJobDueAt,
} from "./intake/settle-job.js";
import type { MessagingReceipts } from "./messaging-receipts.js";

export interface MessagingInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  /**
   * The job queue, also asked whether a sender's backup jobs are still settling earlier messages,
   * and told when one settles so the jobs waiting for it are due.
   */
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancelIn"> & JobQueueOrder;
  /** Records the replies this line sends, and sends them straight away. */
  delivery: Pick<MessagingDelivery, "recordIn" | "send">;
  sandbox: SandboxProvider;
  provision: (request: MessagingIdentityRequest) => Promise<ProvisionedMessagingIdentity>;
  /**
   * Poke-style open line: unknown senders auto-provision their own account.
   * Off by default — strangers' runs would bill the deployment model key.
   */
  openSignup: boolean;
  acknowledge?: MessagingReceipts["acknowledge"];
  storeAttachment?: InboundAttachmentStore;
  /**
   * Transcribes inbound audio with the bot owner's voice provider. On null or
   * a throw only the file reference is delivered. `signal` aborts when the
   * budget runs out.
   */
  transcribe?: (input: {
    spaceId: string;
    userId: string;
    audio: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

/** A stored inbound attachment, with spoken words when audio was transcribed. */
type StoredAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  transcript?: string;
};

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 messages are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE/STOP owner commands).
 * Group messages drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createMessagingInboundHandler(deps: MessagingInboundDeps) {
  const intake: DirectIntake = {
    senders: createSenderQueue(),
    settling: new Map(),
    handedOff: new Map(),
    pending: new Map(),
    closing: false,
  };
  const handle = async (event: MessagingInboundMessage): Promise<void> => {
    if (!event.isDirect) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, intake, event).catch(droppedWhileDeleting);
  };
  return Object.assign(handle, {
    /**
     * The start of a shutdown, before anything waits: nothing more is posted here, and every
     * message still settling has its backup job made due just past a short grace, so the job
     * settles it soon even if the process is killed before `handOffPending`. Downloads get that
     * grace, counted from now; a message that comes in after is its job's from the start.
     */
    prepareHandOff: async (): Promise<void> => {
      await beginShutdown(deps, intake).recorded;
    },
    /**
     * The end of a shutdown: once the downloads still running have finished or the grace is
     * over, every message still settling has its job due now, and the job finds the files stored
     * meanwhile.
     */
    handOffPending: async (): Promise<void> => {
      const shutdown = beginShutdown(deps, intake);
      await shutdown.recorded;
      const graceOver = new AbortController();
      await Promise.race([
        // A message being handed to the bot here finishes that within the grace too.
        Promise.allSettled(
          shutdown.arrivals.map((arrival) =>
            arrival.delivering ? arrival.settled : arrival.media,
          ),
        ),
        abortableDelay(Math.max(0, shutdown.graceEnds - Date.now()), graceOver.signal),
      ]);
      graceOver.abort();
      intake.handingOff = undefined;
      // One at a time, so a kill partway leaves no later message due before an earlier one.
      for (const arrival of shutdown.arrivals) {
        // One being handed to the bot here ends its own job, or hands it off if that fails.
        if (!arrival.delivering) await handOffToJob(deps, intake, arrival);
      }
    },
  });
}

/** A shutdown, started once: its messages, in each sender's order, have their jobs due soon. */
function beginShutdown(deps: MessagingInboundDeps, intake: DirectIntake): Shutdown {
  if (intake.shutdown) return intake.shutdown;
  intake.closing = true;
  const now = Date.now();
  const shutdown: Shutdown = {
    arrivals: [...intake.pending.values()].flat(),
    graceEnds: now + SHUTDOWN_DOWNLOAD_GRACE_MS,
    dueBy: now + SHUTDOWN_DOWNLOAD_GRACE_MS + SHUTDOWN_HANDOFF_MARGIN_MS,
    last: new Map(),
    recorded: Promise.resolve(),
  };
  intake.shutdown = shutdown;
  intake.handingOff = shutdown;
  // One at a time, in order, as the hand-off at the end goes.
  shutdown.recorded = (async () => {
    for (const arrival of shutdown.arrivals) await dueByShutdown(deps, intake, shutdown, arrival);
  })();
  return shutdown;
}

/** The direct messages this process is still settling. */
type DirectIntake = {
  /** One sender's messages reach the bot in the order they arrived here. */
  senders: SenderQueue;
  /** Messages settling here, so a redelivery meanwhile adds nothing. */
  settling: Map<string, Arrival>;
  /**
   * Senders whose messages go to their backup jobs instead of reaching the bot from here, with
   * when the last of those jobs is due: one of their messages failed here, or the job queue
   * still held jobs of theirs when they wrote again. Each next job is due after it, so the
   * sender's job queue settles them in the order sent, until the sender has nothing pending here.
   */
  handedOff: Map<string, number>;
  /** Each sender's messages here, from arrival until their turn in the queue is over. */
  pending: Map<string, Arrival[]>;
  /** Shutting down: the backup jobs settle what is left. */
  closing: boolean;
  /** The shutdown, once it started. */
  shutdown?: Shutdown;
  /** During a shutdown's grace, the messages it hands off once the grace is over. */
  handingOff?: Shutdown;
};

/** A shutdown's hand-off: its messages, and when their jobs are due at the latest meanwhile. */
type Shutdown = {
  arrivals: Arrival[];
  /** When the downloads still running stop being waited for. */
  graceEnds: number;
  dueBy: number;
  /** The first writes making the jobs due by `dueBy`. */
  recorded: Promise<void>;
  /** When each sender's last job is due meanwhile, so the next comes after it. */
  last: Map<string, number>;
};

/** One direct message from its arrival here. */
type Arrival = {
  sender: string;
  /**
   * When it arrived, taken again in its record turn, after the sender's earlier messages here: an
   * owner's "stop" recorded after this keeps it from starting a turn.
   */
  receivedAt: number;
  /** Being handed to the bot here, so a shutdown leaves its job alone. */
  delivering?: boolean;
  /** Its turn in its sender's queue, over once it settled here or went to its job. */
  settled?: Promise<void>;
  /** Its backup job once recorded, until the message settles here. */
  job?: SettleJob;
  /** Its downloads, once they started. */
  media?: Promise<MediaOutcome>;
  /** The writes of its job so far, which go one at a time. */
  writes: Promise<void>;
  /**
   * Over once the sender's earlier arrivals here recorded their backup jobs or will record none,
   * so the jobs keep the order the messages arrived in.
   */
  recordTurn: Promise<void>;
  /** Ends its own turn: its job is recorded, or it records none. */
  endRecordTurn: () => void;
  /** Over once its own turn and every turn before it are. */
  recorded: Promise<void>;
};

/** A message's backup job as last written, and when it is due. */
type SettleJob = { payload: SettlePayload; dueAt: number };

/**
 * What is left of a direct message once its webhook can be answered. `inline` work is part of
 * the answer, so a failure makes the provider deliver it again; any other is the message's
 * files and turn, after the answer, with its backup job recorded.
 */
type DirectSettle = { inline: boolean; run: () => Promise<void> };

/** A Space being deleted takes no messages; failing would only make the provider redeliver. */
function droppedWhileDeleting(error: unknown): void {
  if (!(error instanceof SpaceDeletionInProgressError)) throw error;
  getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
}

/**
 * Answers a direct message's webhook once the message is safe; its files start downloading then,
 * and it reaches the bot in its sender's order. The sender's place is taken on arrival, before any
 * lookup, so a quick text never overtakes the file message sent before it. Plain text from a
 * sender with nothing pending, here or in the job queue, is still delivered within the webhook.
 */
async function handleDirectEvent(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  event: MessagingInboundMessage,
): Promise<void> {
  const sender = JSON.stringify([event.provider, event.from]);
  const behind = intake.senders.busy(sender);
  // Nothing of theirs is pending here; the job queue is asked about its own once they are known.
  if (!behind) intake.handedOff.delete(sender);
  const pending = intake.pending.get(sender) ?? [];
  const arrival = arrivalAfter(sender, pending.at(-1));
  pending.push(arrival);
  intake.pending.set(sender, pending);
  const prepared = prepareDirectEvent(deps, intake, event, behind, arrival);
  // However its preparation ends, the sender's next message may record its job then.
  void Promise.allSettled([prepared]).then(arrival.endRecordTurn);
  const settled = intake.senders.run(sender, async () => {
    try {
      // A failed preparation is the webhook's failure, and the provider delivers it again.
      const [outcome] = await Promise.allSettled([prepared]);
      if (outcome.status === "fulfilled") await outcome.value?.run();
    } finally {
      pending.splice(pending.indexOf(arrival), 1);
      if (pending.length === 0 && intake.pending.get(sender) === pending) {
        intake.pending.delete(sender);
        // Nothing of theirs is pending here; their next message asks the job queue afresh.
        intake.handedOff.delete(sender);
      }
    }
  });
  arrival.settled = settled.then(
    () => undefined,
    () => undefined,
  );
  const settle = await prepared;
  if (settle?.inline) await settled;
}

/** A direct message just arrived, whose job is recorded after that of the one before it here. */
function arrivalAfter(sender: string, previous: Arrival | undefined): Arrival {
  let endRecordTurn = () => {};
  const ownTurn = new Promise<void>((resolve) => {
    endRecordTurn = resolve;
  });
  const recordTurn = previous?.recorded ?? Promise.resolve();
  return {
    sender,
    receivedAt: Date.now(),
    writes: Promise.resolve(),
    recordTurn,
    endRecordTurn,
    recorded: recordTurn.then(() => ownTurn),
  };
}

/**
 * Everything a direct message needs before its webhook is answered: the identity, owner
 * commands and link codes, and for a message that settles later, its backup job. Returns null
 * when nothing is left to deliver.
 */
async function prepareDirectEvent(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  event: MessagingInboundMessage,
  behind: boolean,
  arrival: Arrival,
): Promise<DirectSettle | null> {
  // Media that only the provider can download (Telegram file_id fetches) rides
  // along in event.attachments; CDN media keeps riding along as text.
  const attachments = event.attachments ?? [];
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");

  const where = { provider_address: { provider: event.provider, address: event.from } } as const;
  const existing = await deps.prisma.messagingIdentity.findUnique({ where });
  if (existing && event.installationSpaceId && existing.spaceId !== event.installationSpaceId)
    return null;
  // A deactivated person's chat apps act for nobody: no commands, messages or links.
  if (existing && (await accountDeactivated(deps.prisma, existing.userId))) return null;
  if (existing) {
    const command = parseMessagingCommand(event.content);
    const releasesHeld = existing.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP;
    // Read what a YES or NO answers before the held replies below go out: one
    // of them may be a request the person had not seen when they replied. A
    // redelivery of the reply that already released them answers nothing.
    const prompt =
      (command === "approve" || command === "decline") && existing.capReleaseHandle !== event.handle
        ? await latestPrompt(deps, existing)
        : null;
    // Any reply — even a content-free reaction — ends the consecutive-
    // outbound streak, but only real text wakes the bot. The conversation
    // id is refreshed from the webhook so outbound always has a thread.
    await deps.prisma.messagingIdentity.update({
      where: { id: existing.id },
      data: {
        outboundSinceInbound: 0,
        lastInboundAt: new Date(),
        dmThreadId: event.threadId,
        ...(releasesHeld ? { capReleaseHandle: event.handle } : {}),
      },
    });
    // Replies held behind the consecutive-outbound cap can go now.
    if (releasesHeld) await deps.delivery.send([{ identityId: existing.id }]);
    if (!text && attachments.length === 0) return null;
    // Owner commands are only parsed in the verified 1:1 conversation.
    if (command === "stop") {
      // Only a bare "stop" is the command; one carrying media is delivered as a message.
      if (attachments.length === 0 && !event.mediaUrl) {
        // It acts once the messages sent before it have their arrival times, without waiting for
        // their files: they still reach the chat when they settle, but start nothing
        // (`stoppedSince`).
        await arrival.recordTurn;
        await stopOwnerWork(deps, existing, event);
        return null;
      }
    } else if (command && (await applyOwnerCommand(deps, existing, command, prompt))) return null;
    // A linked sender pasting a fresh code re-points this address at another
    // of their bots (only their own codes apply).
    if (await tryRedeemLinkCode(deps, event)) return null;
  } else {
    // Unlinked senders: a valid link code binds this address to its issuer's
    // account and bot; otherwise the line is silent unless the deployment
    // explicitly runs as an open Poke-style signup line.
    if (await tryRedeemLinkCode(deps, event)) return null;
    if (!deps.openSignup || event.installationSpaceId) return null;
    // Media-only delivery is for linked identities; retain text-based signup.
    if (!text) return null;
  }

  let ids: ProvisionedMessagingIdentity;
  if (existing) {
    const thread = await deps.prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`messaging identity ${existing.id} has no thread`);
    ids = {
      provider: existing.provider,
      address: existing.address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    ids = await deps.provision({
      provider: event.provider,
      address: event.from,
      dmThreadId: event.threadId,
      displayName: event.fromLabel ? sanitizeMessagingLabel(event.fromLabel) : null,
    });
  }

  const deadline = arrival.receivedAt + DIRECT_MESSAGE_SETTLE_BUDGET_MS;
  // Earlier messages of theirs may still be with their backup jobs, after a failure here, a
  // restart, or on another instance: this one follows them there rather than overtaking them.
  const ownJob =
    existing && !behind
      ? await followQueuedJobs(deps, intake, arrival.sender, existing.id, event)
      : false;
  if (attachments.length === 0 && !behind && !intake.handedOff.has(arrival.sender)) {
    return {
      inline: true,
      run: async () => {
        await deliverDirectMessage(deps, ids, event, text, NO_MEDIA, false);
        // A redelivery of a message that once went to its backup job: that job has nothing left
        // to do, and must not hold the sender's next messages back. The message is posted
        // already, so a failure here must not fail its webhook; the job then runs as recorded.
        if (existing && ownJob) {
          await bestEffort(
            "end a redelivered inbound message's own backup job",
            endOwnJob(deps, existing.id, event),
          );
        }
      },
    };
  }
  // Its backup job cannot download files, so while this process stops, a file message fails its
  // webhook and the provider delivers it again to one that is up.
  if (intake.closing && attachments.length > 0) {
    throw new Error("messaging inbound refused a file message while shutting down");
  }
  const message = JSON.stringify([event.provider, event.handle]);
  // The provider delivered it again while its files are still downloading here.
  if (intake.settling.has(message)) return null;
  intake.settling.set(message, arrival);
  try {
    const identityId =
      existing?.id ??
      (await deps.prisma.messagingIdentity.findUniqueOrThrow({ where, select: { id: true } })).id;
    // After the jobs of the sender's earlier messages here, though this one's lookups may finish
    // first: the job queue places a job by when it was first recorded. Its arrival time is taken
    // then too, so it falls after a stop sent before it, which records itself in its own turn.
    await arrival.recordTurn;
    arrival.receivedAt = await inboundArrivalTime(deps.prisma);
    const receivedAt = arrival.receivedAt;
    const job = { provider: event.provider, handle: event.handle, identityId };
    // The Space and bot it was sent to; the job drops it if the sender re-linked meanwhile.
    // The job keeps what the person wrote, sealed, and never the media link that rides along. It
    // names every file, those past the cap too, so it can say what became of each.
    const payload: SettlePayload = {
      ...job,
      spaceId: ids.spaceId,
      botId: ids.botId,
      receivedAt,
      text: await sealSettleText(deps.prisma, ids.spaceId, job, event.content),
      attachments: attachments
        .slice(0, MESSAGING_INBOUND_SETTLE_MAX_ATTACHMENTS)
        .map(({ name, mimeType, size }) => ({
          name,
          mimeType,
          ...(size !== undefined && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
        })),
    };
    const dueAt = settleJobDueAt(receivedAt);
    try {
      await deps.prisma.$transaction((tx) => recordSettleJob(deps.jobs, tx, payload, dueAt));
    } finally {
      arrival.endRecordTurn();
    }
    arrival.job = { payload, dueAt: dueAt.getTime() };
    // Arriving during a shutdown, it is its backup job's, after the sender's earlier messages.
    if (intake.closing) {
      intake.settling.delete(message);
      const shutdown = intake.handingOff;
      if (!shutdown) await handOffToJob(deps, intake, arrival);
      else {
        // It may have been waiting for its job when the shutdown started.
        if (!shutdown.arrivals.includes(arrival)) shutdown.arrivals.push(arrival);
        await dueByShutdown(deps, intake, shutdown, arrival);
      }
      return null;
    }
    // The files download from now on, whatever is ahead of the message in its sender's queue;
    // only handing the message to the bot waits its turn there.
    const media = settledMedia(storeInboundMedia(deps, ids, event, deadline));
    arrival.media = media;
    return {
      inline: false,
      run: () =>
        (intake.closing
          ? Promise.resolve()
          : intake.handedOff.has(arrival.sender)
            ? // A shutdown meanwhile hands it off itself.
              media.then(() => (intake.closing ? undefined : handOffToJob(deps, intake, arrival)))
            : settleDirectMessage(deps, intake, ids, event, arrival, text, media)
        ).finally(() => intake.settling.delete(message)),
    };
  } catch (error) {
    intake.settling.delete(message);
    throw error;
  }
}

/**
 * Settles a message whose webhook was answered, in its sender's turn: once its files are in, the
 * bot's turn, and one notice to the sender when files did not arrive, which commits with the end
 * of its backup job. Never rejects: a failure hands the message, and the sender's messages queued
 * behind it, to their backup jobs at once.
 */
async function settleDirectMessage(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
  arrival: Arrival,
  text: string,
  media: Promise<MediaOutcome>,
): Promise<void> {
  try {
    const outcome = await media;
    // A shutdown hands the message to its backup job instead.
    if (intake.closing) return;
    if ("error" in outcome) throw outcome.error;
    const quiet = arrival.job
      ? await stoppedSince(deps.prisma, arrival.job.payload.identityId, arrival.receivedAt)
      : false;
    if (intake.closing) return;
    // From here the message is this path's: a shutdown must not also make its job due, which
    // could post it a second time beside a message routine's run.
    arrival.delivering = true;
    const unavailable = await deliverDirectMessage(deps, ids, event, text, outcome.stored, quiet);
    const lane = await writeJob(arrival, async (job) => {
      const lane = { identityId: job.payload.identityId };
      await deps.prisma.$transaction(async (tx) => {
        if (unavailable.length > 0) {
          await deps.delivery.recordIn(tx, lane, [
            filesNotReceivedReply(lane.identityId, event.provider, event.handle),
          ]);
        }
        await cancelSettleJob(deps.jobs, tx, job.payload);
        // The sender's jobs that waited only for this one are due now.
        await deps.jobs.releaseFollowersIn(
          tx,
          messagingInboundSettleQueue(lane.identityId),
          messagingInboundSettleJobKey(event.provider, event.handle),
        );
      });
      arrival.job = undefined;
      return lane;
    });
    // The notice is recorded with its own backup, so a failed send here is retried there.
    if (lane && unavailable.length > 0) {
      await bestEffort("send the files-not-received notice", deps.delivery.send([lane]));
    }
  } catch (error) {
    // The job drops a message for a Space being deleted, as this path would.
    if (!(error instanceof SpaceDeletionInProgressError)) {
      getLogger().error("messaging inbound settle failed; its backup job takes over", error);
    }
    await handOffToJob(deps, intake, arrival);
  }
}

/**
 * The sender's backup jobs still settling earlier messages, wherever those arrived: their next
 * messages go after them, until the sender has nothing pending here. Returns whether the message
 * has a job of its own, left from an earlier delivery of it.
 */
async function followQueuedJobs(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  sender: string,
  identityId: string,
  event: MessagingInboundMessage,
): Promise<boolean> {
  // A redelivery of this very message does not wait on its own job.
  const { until, own } = await deps.jobs.pendingUntil(
    messagingInboundSettleQueue(identityId),
    messagingInboundSettleJobKey(event.provider, event.handle),
  );
  if (until) {
    intake.handedOff.set(sender, Math.max(intake.handedOff.get(sender) ?? 0, until.getTime()));
  }
  return own;
}

/** The message's own job, left from an earlier delivery of it, ends; its followers are due. */
async function endOwnJob(
  deps: MessagingInboundDeps,
  identityId: string,
  event: MessagingInboundMessage,
): Promise<void> {
  const key = messagingInboundSettleJobKey(event.provider, event.handle);
  await deps.prisma.$transaction(async (tx) => {
    await deps.jobs.cancelIn(tx, key);
    await deps.jobs.releaseFollowersIn(tx, messagingInboundSettleQueue(identityId), key);
  });
}

/**
 * The message's backup job, already recorded, settles it instead of this process. It comes due
 * after the sender's jobs still queued ahead of it, read again now since some may have settled
 * after the message arrived, so their job queue keeps the order they were sent in; the sender's
 * messages queued behind it here follow it there.
 */
function handOffToJob(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  arrival: Arrival,
): Promise<void> {
  if (!arrival.job) return Promise.resolve();
  return writeJob(arrival, async (job) => {
    const { identityId, provider, handle } = job.payload;
    const ahead = await bestEffort(
      "read the backup jobs an inbound message waits for",
      deps.jobs.pendingUntil(
        messagingInboundSettleQueue(identityId),
        messagingInboundSettleJobKey(provider, handle),
      ),
    );
    // Without an answer, it keeps to what this process last knew of the queue.
    const after =
      ahead === undefined ? intake.handedOff.get(arrival.sender) : ahead.until?.getTime();
    const now = Date.now();
    const dueAt = Math.max(now, after === undefined ? 0 : after + 1);
    intake.handedOff.set(
      arrival.sender,
      Math.max(intake.handedOff.get(arrival.sender) ?? 0, dueAt),
    );
    job.dueAt = dueAt;
    const { follower: _was, ...rest } = job.payload;
    const payload: SettlePayload = {
      ...rest,
      // Due later than now only to wait for the jobs ahead of it, which make it due as they settle.
      ...(dueAt > now ? { follower: true } : {}),
    };
    await bestEffort(
      "hand an inbound message to its backup job",
      writeSettleJob(deps, payload, dueAt),
    );
    job.payload = payload;
  }).then(() => undefined);
}

/**
 * Writes the message's backup job again under its key. A follower is written together with a
 * release of the sender's queue, so if the jobs it waits for settled after they were read, it is
 * due now instead of at its late time.
 */
async function writeSettleJob(
  deps: MessagingInboundDeps,
  payload: SettlePayload,
  dueAt: number,
): Promise<void> {
  if (!payload.follower) return settleJobAt(deps.jobs, payload, new Date(dueAt));
  await deps.prisma.$transaction(async (tx) => {
    await recordSettleJob(deps.jobs, tx, payload, new Date(dueAt));
    await deps.jobs.releaseFollowersIn(tx, messagingInboundSettleQueue(payload.identityId));
  });
}

/**
 * During a shutdown's grace: the message's job is due by the end of it, after the sender's jobs
 * before it, so a process killed meanwhile still leaves it settling soon. A job due sooner, or
 * waiting for the jobs ahead of it, keeps its time. One that follows jobs queued elsewhere stays
 * behind them, though unmarked: its files may still be downloading, so the jobs it follows must
 * not make it due as they settle. The hand-off at the end of the grace marks it.
 */
function dueByShutdown(
  deps: MessagingInboundDeps,
  intake: DirectIntake,
  shutdown: Shutdown,
  arrival: Arrival,
): Promise<void> {
  const job = arrival.job;
  if (!job || arrival.delivering) return Promise.resolve();
  const after = shutdown.last.get(arrival.sender) ?? intake.handedOff.get(arrival.sender);
  const dueAt = Math.max(shutdown.dueBy, after === undefined ? 0 : after + 1);
  if (job.dueAt <= dueAt || job.payload.follower) {
    shutdown.last.set(arrival.sender, Math.max(after ?? job.dueAt, job.dueAt));
    return Promise.resolve();
  }
  shutdown.last.set(arrival.sender, dueAt);
  job.dueAt = dueAt;
  return writeJob(arrival, async (current) => {
    // No follower, so no release goes with it either.
    const { follower: _was, ...payload } = current.payload;
    await bestEffort(
      "make an inbound message's backup job due soon",
      settleJobAt(deps.jobs, payload, new Date(current.dueAt)),
    );
    current.payload = payload;
  }).then(() => undefined);
}

/**
 * One message's job writes go one at a time, each with its latest state, so a later one never
 * loses to an earlier one; none once the message settled here and its job is gone.
 */
function writeJob<T>(
  arrival: Arrival,
  write: (job: SettleJob) => Promise<T>,
): Promise<T | undefined> {
  const result = arrival.writes.then(() => (arrival.job ? write(arrival.job) : undefined));
  arrival.writes = Promise.allSettled([result]).then(() => undefined);
  return result;
}

/** A message's stored files and the lines of those that did not arrive. */
type StoredMedia = Awaited<ReturnType<typeof storeInboundMedia>>;

const NO_MEDIA: StoredMedia = { artifacts: [], unavailable: [] };

/** How a message's downloads ended, kept until its turn in the queue comes to post it. */
type MediaOutcome = { stored: StoredMedia } | { error: unknown };

function settledMedia(media: Promise<StoredMedia>): Promise<MediaOutcome> {
  return media.then(
    (stored) => ({ stored }),
    (error: unknown) => ({ error }),
  );
}

/**
 * Hands the message, with its stored files, to the bot or to the message routines that take
 * it; a quiet one only joins the chat. Returns the lines of the files that did not arrive.
 */
async function deliverDirectMessage(
  deps: MessagingInboundDeps,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
  text: string,
  stored: StoredMedia,
  /** An owner's "stop" came after it: it joins the chat but starts nothing. */
  quiet: boolean,
): Promise<string[]> {
  // Message-trigger routines own the delivery when configured. Do not also
  // start a normal messaging continue for the same inbound handle.
  if (
    !quiet &&
    (await wakeMessageRoutines(deps, ids, event, {
      artifacts: stored.artifacts,
      unavailable: stored.unavailable,
    }))
  )
    return stored.unavailable;
  const body = [text, ...stored.unavailable].filter(Boolean).join("\n");
  const sent = await deps.events.sendUserMessage({
    spaceId: ids.spaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    // The address is verified as this person\'s, so the line is theirs.
    authorUserId: ids.userId,
    blocks: [
      ...(body ? [{ kind: "text" as const, text: body }] : []),
      ...stored.artifacts.map((artifact) => messageBlockForArtifact(artifact)),
    ],
    prompt: promptTextForAttachments(body, stored.artifacts),
    trigger: "messaging",
    clientNonce: messagingMessageClientNonce(event.provider, event.handle),
    ...(quiet ? { createRun: false } : {}),
  });
  if (sent.runId) {
    const runId = sent.runId;
    deps.acknowledge?.(event.threadId, event.handle, async () => {
      const run = await deps.prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, messagingMirroredAt: true },
      });
      if (!run) return false;
      // A failed or cancelled run may never be mirrored, and no reply is coming.
      if (run.status === "failed" || run.status === "cancelled") return true;
      if (!run.messagingMirroredAt) return false;
      // Recording only queues the reply. It has gone out once none of this
      // run's recorded rows are still waiting to be sent.
      const replies = await deps.prisma.message.findMany({
        where: { runId, role: "bot" },
        select: { id: true },
      });
      if (replies.length === 0) return true;
      const unsent = await deps.prisma.messagingOutbound.count({
        where: {
          sourceMessageId: { in: replies.map((reply) => reply.id) },
          // Not out yet: waiting, or claimed (sent with no handle yet).
          OR: [{ status: { not: "sent" } }, { providerHandle: null }],
        },
      });
      return unsent === 0;
    });
    await wakeRun(deps.jobs, sent.runId);
  }
  return stored.unavailable;
}

/** Time for all voice note transcripts of one inbound message; files are delivered without them after it. */
const VOICE_TRANSCRIBE_BUDGET_MS = 20_000;

/**
 * How far a roster's platform time may run ahead of the server's clock and still count
 * as the roster's version; further ahead the event applies its membership unversioned.
 */
const ROSTER_TIME_SKEW_MS = 5 * 60_000;

/** Download provider-held files into thread artifacts, then transcribe voice notes. */
async function storeInboundMedia(
  deps: MessagingInboundDeps,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
  downloadDeadline: number,
) {
  const { stored, unavailable } = await storeInboundAttachments(
    deps.storeAttachment,
    ids,
    event.attachments ?? [],
    {
      clientNonce: (index) => messagingAttachmentClientNonce(event.provider, event.handle, index),
      limit: ATTACHMENT_MAX_COUNT,
      downloadDeadline,
      downloadTimeoutMs: DIRECT_ATTACHMENT_TIMEOUT_MS,
      attempts: DIRECT_ATTACHMENT_ATTEMPTS,
      reasons: true,
    },
  );
  // Transcribe only after every download, so a slow transcription cannot use up the
  // download deadline of the attachments that follow it. One short budget covers all
  // transcripts, which the message's backup job leaves time for.
  const transcribeDeadline = Date.now() + VOICE_TRANSCRIBE_BUDGET_MS;
  const artifacts: StoredAttachment[] = [];
  for (const { artifact, bytes } of stored) {
    artifacts.push(await withVoiceTranscript(deps, ids, artifact, bytes, transcribeDeadline));
  }
  return { artifacts, unavailable };
}

/**
 * Best-effort transcript for a stored audio attachment. No provider, oversize
 * audio or a failed call leaves the artifact unchanged, so the message is
 * still delivered with the file reference.
 */
async function withVoiceTranscript(
  deps: MessagingInboundDeps,
  ids: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId">,
  artifact: StoredAttachment,
  bytes: Uint8Array | undefined,
  deadline: number,
): Promise<StoredAttachment> {
  if (!deps.transcribe || !bytes || !isAttachmentAudioMimeType(artifact.mimeType)) return artifact;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return artifact;
  // The timer both stops waiting and cancels the provider call, so a stalled
  // request does not keep running after the message is delivered without it.
  const cancel = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      cancel.abort();
      resolve(null);
    }, remaining);
  });
  const call = deps
    .transcribe({
      spaceId: ids.spaceId,
      userId: ids.userId,
      audio: bytes,
      mimeType: artifact.mimeType,
      signal: cancel.signal,
    })
    .catch((error) => {
      // Reason only: the audio and the transcript never reach the log.
      getLogger().warn("messaging attachment transcription failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const transcript = await Promise.race([call, timedOut]).finally(() => clearTimeout(timer));
  // Normalized once here, so the direct prompt and the routine payload carry the same bounded text.
  const normalized = normalizeVoiceTranscript(transcript);
  return normalized ? { ...artifact, transcript: normalized } : artifact;
}

/** Wake provider-neutral message routines through the same approval boundary as webhooks. */
export async function wakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma" | "events"> & {
    jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancelIn">;
  },
  target: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId" | "botId" | "threadId">,
  event: MessagingInboundMessage,
  options?: {
    /** Wake clientNonce prefix; must match TeamChatBridge.providerId when event.provider differs. */
    deliveryProvider?: string;
    artifacts?: StoredAttachment[];
    unavailable?: string[];
    /**
     * TeamChat external message id. The wake claims the deferred message in the
     * transaction that starts its run, so the agent can never also answer it.
     * Returns true when the agent already had it.
     */
    externalMessageId?: string;
  },
): Promise<boolean> {
  const routines = await deps.prisma.routine.findMany({
    where: {
      botId: target.botId,
      spaceId: target.spaceId,
      // The wake runs as the identity's person, so only their own routines may ride on it.
      userId: target.userId,
      active: true,
      messageProvider: event.provider,
    },
    select: {
      id: true,
      name: true,
      prompt: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (routines.length === 0) return false;

  const prompt = formatMessagingEventPrompt(event.provider, {
    provider: event.provider,
    kind: event.isDirect ? "direct" : "channel",
    handle: event.handle,
    from: event.from,
    fromLabel: event.fromLabel,
    channelName: event.channelName,
    content: event.content,
    mediaUrl: event.mediaUrl,
    ...(options?.unavailable?.length ? { unavailable: options.unavailable } : {}),
    ...(event.attachments?.length
      ? {
          files: event.attachments.map(({ name, mimeType, size }) => ({
            name,
            mimeType,
            size,
          })),
        }
      : {}),
    ...(options?.artifacts?.some((artifact) => artifact.transcript)
      ? {
          voiceTranscripts: options.artifacts
            .filter((artifact) => artifact.transcript)
            .map((artifact) => ({ name: artifact.name, transcript: artifact.transcript })),
        }
      : {}),
  });
  const externalMessageId = options?.externalMessageId;
  try {
    await deliverWebhookEvent(
      { events: deps.events, jobs: deps.jobs },
      {
        bot: { id: target.botId, spaceId: target.spaceId, userId: target.userId },
        threadId: target.threadId,
      },
      {
        prompt,
        attachmentBlocks: options?.artifacts?.map(messageBlockForArtifact),
        routines,
        source: "messaging",
        idempotencyKey: messagingWakeIdempotencyKey(
          options?.deliveryProvider ?? event.provider,
          event.handle,
        ),
        // TeamChat channel wakes may share a live thread with an active chat run.
        allowParallelRun: true,
        ...(externalMessageId
          ? {
              claim: async (tx: Prisma.TransactionClient) => {
                const claimed = await tx.externalMessage.updateMany({
                  where: { id: externalMessageId, status: "deferred" },
                  data: { status: "ignored", engagementReason: "message_routine_wake" },
                });
                if (claimed.count !== 1) return false;
                await deps.jobs.cancelIn(tx, teamChatEngageJobKey(externalMessageId));
                return true;
              },
            }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof SendClaimLostError) return true;
    throw error;
  }
  return true;
}

/**
 * TeamChat engagement can still receive the message, but unattended
 * message-routine wakes reuse the personal-line approval boundary:
 * linked identity for DMs; approved channel member when we have membership
 * state; otherwise a linked identity so public-channel strangers cannot start
 * active routines.
 */
export async function teamChatSenderCanWakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma">,
  event: MessagingInboundMessage,
): Promise<boolean> {
  if (event.senderIsBot) return false;

  const linkedIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { id: true, userId: true },
  });
  // A deactivated person counts as unlinked: like anyone in the workspace, never as themselves.
  if (linkedIdentity && (await accountDeactivated(deps.prisma, linkedIdentity.userId)))
    return false;

  if (event.isDirect) return Boolean(linkedIdentity);

  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { threadId: event.threadId },
    select: { id: true },
  });
  if (channel) {
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address: event.from } },
      select: { status: true },
    });
    return member?.status === "approved";
  }

  // Pure TeamChat workspace rooms have no personal membership ledger.
  // Still require a linked sender before waking message routines.
  return Boolean(linkedIdentity);
}

/**
 * Returns true when the message was exactly a link code that redeemed:
 * the address is now bound to the issuer's chosen bot and a confirmation
 * DM is on its way. An invalid or expired code falls through silently —
 * for linked senders it reads as a normal message, for strangers nothing
 * happens (no oracle, no reply spam).
 */
async function tryRedeemLinkCode(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<boolean> {
  const code = normalizeMessagingLinkCode(event.content);
  if (!code) return false;
  const redeemed = await redeemMessagingLinkCode(
    deps.prisma,
    {
      code,
      provider: event.provider,
      address: event.from,
      dmThreadId: event.threadId,
      spaceId: event.installationSpaceId,
      installationId: event.installationId,
    },
    async (tx, linked) => {
      const bot = await tx.bot.findUnique({
        where: { id: linked.botId },
        select: { name: true },
      });
      await writeConfirmation(
        deps,
        tx,
        { id: linked.identityId },
        linked.confirmationKey,
        `Linked. Messages here now reach "${bot?.name ?? "your agent"}".`,
      );
    },
  );
  if (!redeemed) return false;
  await deps.delivery.send([{ identityId: redeemed.identityId }]);
  return true;
}

/**
 * The owner's "stop", an owner command like YES/NO/LEAVE: Stop for their bot's chat, always
 * answered by text. The answer's row, written first, is this delivery's receipt, so a
 * redelivered or concurrent copy finds it and changes nothing.
 */
async function stopOwnerWork(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  event: MessagingInboundMessage,
): Promise<void> {
  const thread = await deps.prisma.thread.findFirstOrThrow({
    where: { botId: identity.botId },
    select: { id: true },
  });
  const key = ownerStopKey(identity.id, event.handle);
  const target = { kind: "bot", botId: identity.botId, threadId: thread.id } as const;
  const stop = await deps.prisma.$transaction(async (tx) => {
    const receipt = await deps.delivery.recordIn(tx, { identityId: identity.id }, [
      { idempotencyKey: key, kind: "dm", identityId: identity.id, body: "Nothing is running." },
    ]);
    if (receipt.length === 0) return null;
    const stop = await cancelThreadRuns(identity, target, { botId: identity.botId })(tx);
    if (stop.runIds.length) {
      await tx.messagingOutbound.update({
        where: { idempotencyKey: key },
        data: { body: STOPPED_BY_MESSAGE_NOTE },
      });
    }
    return stop;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await deps.delivery.send([{ identityId: identity.id }]);
  if (stop?.runIds.length) await finishThreadStop(deps, identity, target, stop);
}

/** The newest message this line sent the person, as it stood when their reply arrived. */
function latestPrompt(deps: MessagingInboundDeps, identity: IdentityRow) {
  return deps.prisma.messagingOutbound.findFirst({
    where: { identityId: identity.id, kind: "dm" },
    orderBy: { createdAt: "desc" },
    select: { idempotencyKey: true, createdAt: true, status: true, providerHandle: true },
  });
}

type LatestPrompt = Awaited<ReturnType<typeof latestPrompt>>;

/** How long a channel invite or connection request can be answered by text. */
export const TEXT_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one request a bare YES or NO answers: the request whose prompt was the newest message this
 * line had sent the person when the reply arrived, confirmed delivered within the answer window
 * and still pending. Anything
 * said since, by the bot or the product, makes the reply an ordinary message. So does a newest
 * message that is still on its way or failed: the person may have seen it, so no older prompt may
 * take the reply in its place.
 */
async function answeredRequest(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  latest: LatestPrompt,
) {
  if (
    latest?.status !== "sent" ||
    latest.providerHandle === null ||
    Date.now() - latest.createdAt.getTime() > TEXT_ANSWER_WINDOW_MS
  ) {
    return null;
  }
  const [kind, first, second] = latest.idempotencyKey.split(":");
  if (kind === "invite" && first && second === identity.id) {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { channelId: first, identityId: identity.id, status: "invited" },
    });
    return membership ? ({ kind: "channel", membership } as const) : null;
  }
  if (kind === "connect" && first && second === identity.botId) {
    const connection = await deps.prisma.agentConnection.findFirst({
      where: { requesterBotId: first, targetBotId: identity.botId, status: "pending" },
    });
    return connection ? ({ kind: "connection", connection } as const) : null;
  }
  return null;
}

/** Returns true when the command matched a pending item and was handled. */
async function applyOwnerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  command: Exclude<MessagingCommand, "stop">,
  prompt: LatestPrompt,
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    // One transaction, so a failed confirmation leaves the membership as it
    // was and a redelivered LEAVE cannot move on to the next group.
    const claimed = await deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: membership.id, status: "approved" },
        data: { status: "left" },
      });
      // State changed under us (e.g. swept out and re-invited): treat the
      // text as a normal message rather than overwriting the newer state.
      if (count === 0) return false;
      await writeConfirmation(
        deps,
        tx,
        identity,
        `command:leave:${membership.id}`,
        "You've left the channel. Your agent will no longer post there. The group chat itself is unchanged.",
      );
      return true;
    });
    if (!claimed) return false;
    await deps.delivery.send([{ identityId: identity.id }]);
    return true;
  }

  const target = await answeredRequest(deps, identity, prompt);
  if (!target) return false;
  const approved = command === "approve";

  if (target.kind === "channel") {
    const key = `command:${command}:${target.membership.id}`;
    const claimed = await deps.prisma.$transaction(async (tx) => {
      // The claim holds the membership row lock through commit, so the
      // participant sweep can never interleave with the confirmation write.
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) return false;
      await writeConfirmation(
        deps,
        tx,
        identity,
        key,
        approved
          ? "You're in. Your agent will now see and reply to that group."
          : "No problem, your agent will stay out of that group.",
      );
      return true;
    });
    if (!claimed) return false;
    await deps.delivery.send([{ identityId: identity.id }]);
    return true;
  }

  const connectedKey = `command:connected:${target.connection.id}`;
  const requesterIdentity = approved
    ? await deps.prisma.messagingIdentity.findUnique({
        where: { botId: target.connection.requesterBotId },
      })
    : null;
  const key = `command:${command}:${target.connection.id}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    // The claim holds the connection row lock through commit, so a revoke
    // can never interleave with the confirmation writes.
    if (
      approved &&
      !(await crossSpaceCommunicationAllowed(tx, target.connection.requesterBotId, identity.botId))
    )
      return false;
    const { count } = await tx.agentConnection.updateMany({
      where: { id: target.connection.id, status: "pending" },
      data: { status: approved ? "approved" : "declined" },
    });
    // Revoked or answered elsewhere since the read: not ours to write.
    if (count === 0) return false;
    const confirmations = [
      {
        identity,
        key,
        body: approved
          ? "Connection approved. Your agents can now message each other."
          : "Connection declined.",
      },
      ...(requesterIdentity
        ? [
            {
              identity: requesterIdentity,
              key: connectedKey,
              body: "Your connection request was accepted. Your agents can now message each other.",
            },
          ]
        : []),
    ];
    // In one order every writer agrees on, so two answers cannot deadlock on the two chats.
    for (const confirmation of confirmations.toSorted((a, b) =>
      a.identity.id.localeCompare(b.identity.id),
    ))
      await writeConfirmation(deps, tx, confirmation.identity, confirmation.key, confirmation.body);
    return true;
  });
  if (!claimed) return false;
  await deps.delivery.send([
    { identityId: identity.id },
    ...(requesterIdentity ? [{ identityId: requesterIdentity.id }] : []),
  ]);
  return true;
}

/** Replaces the prior cycle's row, which would otherwise suppress the new confirmation. */
async function writeConfirmation(
  deps: Pick<MessagingInboundDeps, "delivery">,
  tx: Prisma.TransactionClient,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  await deps.delivery.recordIn(
    tx,
    { identityId: identity.id },
    [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    { replace: true },
  );
}

async function handleChannelEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const channelName = event.channelName ? sanitizeMessagingLabel(event.channelName) : null;
  const channel = await deps.prisma.messagingChannel.upsert({
    where: { threadId: event.threadId },
    create: { provider: event.provider, threadId: event.threadId, name: channelName },
    update: channelName ? { name: channelName } : {},
  });

  // Telegram reports departures one service message at a time; a rosterless
  // platform has no sweep, so this delta is the only removal signal. Our own
  // bot leaving ends every membership: nothing more is delivered there. The
  // event itself carries no conversation — no intro, no run — and it runs before
  // member discovery, so a departing sender is never invited or announced.
  if (event.departures) {
    // Leaving the chat ends membership in every conversation of it: forum topics
    // are channels of their own (`<provider>:<chat>:<topic>`) on the same mount.
    const chat = event.threadId.split(":").slice(0, 2).join(":");
    const chatChannels = await deps.prisma.messagingChannel.findMany({
      where: {
        provider: event.provider,
        OR: [{ threadId: chat }, { threadId: { startsWith: `${chat}:` } }],
      },
      select: { id: true },
    });
    // The query includes this channel: its thread id is the chat or one of its topics.
    const channelIds = chatChannels.map((row) => row.id);
    await deps.prisma.messagingChannelMember.updateMany({
      where: event.departures.botLeft
        ? { channelId: { in: channelIds }, status: { in: ["invited", "approved"] } }
        : {
            channelId: { in: channelIds },
            address: { in: event.departures.addresses },
            status: { in: ["invited", "approved"] },
          },
      data: { status: "left" },
    });
    return;
  }

  // A deactivated sender's message does nothing: no invitations, memberships or relays.
  const sender = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { userId: true },
  });
  if (sender && (await accountDeactivated(deps.prisma, sender.userId))) return;

  const participants = [...event.participants];
  if (!participants.includes(event.from)) participants.push(event.from);

  // Roster membership changes go with the roster's own version, under the channel's
  // row lock. A webhook retry can deliver a roster older than one a newer event
  // already settled, and without the lock an older handler could pass the version
  // check, pause, and then sweep members the newer roster had just settled. Whichever
  // handler takes the lock first records its roster time — equal times conflict too —
  // and a handler whose roster is not newer than the recorded one changes no
  // membership at all: no sweep, no re-invite, no discovery. Invitations are
  // announced only after the transaction commits.
  // The roster time is the platform's clock, which can run ahead of ours. Within a
  // small skew it stays the version, so ordering and redeliveries behave as usual.
  // Further ahead the time is bogus and the event's roster is distrusted whole, on
  // every delivery alike: it changes no membership — no discovery, no invites, no
  // sweep — and records no time, so it can never settle or unsettle members, and a
  // far-future time can never sit ahead of every later real roster and freeze it.
  const eventRosterAt = event.participants.length > 0 ? event.rosterAt : undefined;
  const rosterTimeRejected =
    eventRosterAt !== undefined && eventRosterAt.getTime() > Date.now() + ROSTER_TIME_SKEW_MS;
  const rosterAt = rosterTimeRejected ? undefined : eventRosterAt;
  const invited: IdentityRow[] = [];
  const invites: OutboundInvite[] = [];
  let hasUnlinked = false;
  await deps.prisma.$transaction(async (tx) => {
    // A rejected time distrusts the event's membership entirely; its message content,
    // if any, still flows below as for any message.
    if (rosterTimeRejected) return;
    await tx.$queryRaw`SELECT id FROM messaging_channels WHERE id = ${channel.id} FOR UPDATE`;
    if (rosterAt) {
      const settled = await tx.messagingChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { rosterSeenAt: true },
      });
      if (settled.rosterSeenAt && rosterAt <= settled.rosterSeenAt) return;
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { rosterSeenAt: rosterAt },
      });
    }
    for (const address of participants) {
      const identity = await tx.messagingIdentity.findUnique({
        where: { provider_address: { provider: event.provider, address } },
      });
      const member = await tx.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address } },
      });
      if (member) {
        // Compare against the current identity, not just null: unlinking
        // deletes the identity row but leaves this FK-free column pointing at
        // the dead id, so a re-link would otherwise never reattach and the
        // member would sit in the channel unreachable by every lookup.
        if (identity && member.identityId !== identity.id) {
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { identityId: identity.id },
          });
          if (member.status === "invited") {
            if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
          }
        }
        if (member.status === "left") {
          // Back in the group: restart the approval cycle.
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { status: "invited" },
          });
          if (identity) {
            if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
          }
        }
        if (!identity) hasUnlinked = true;
        continue;
      }
      // Upsert, not create: concurrent group webhooks race on the unique key.
      await tx.messagingChannelMember.upsert({
        where: { channelId_address: { channelId: channel.id, address } },
        create: {
          channelId: channel.id,
          address,
          identityId: identity?.id ?? null,
          status: "invited",
        },
        update: {},
      });
      if (identity) {
        if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
      } else hasUnlinked = true;
    }

    // Someone removed from the group must stop receiving its content.
    // A webhook without a participants roster says nothing about membership —
    // never sweep on partial data.
    if (event.participants.length > 0) {
      await tx.messagingChannelMember.updateMany({
        where: {
          channelId: channel.id,
          address: { notIn: participants },
          status: { in: ["invited", "approved"] },
        },
        data: { status: "left" },
      });
    }
    // In one order every writer agrees on, so two groups inviting the same people cannot
    // deadlock on their conversations.
    for (const invite of invites.toSorted((a, b) => a.identityId.localeCompare(b.identityId)))
      await deps.delivery.recordIn(tx, { identityId: invite.identityId }, [invite], {
        replace: true,
      });
  });
  for (const identity of invited) await announceInvite(deps, channel, identity);
  if (invites.length > 0)
    await deps.delivery.send(invites.map(({ identityId }) => ({ identityId })));

  if (hasUnlinked && !channel.introPostedAt) {
    const lane: OutboundLane = { identityId: null, threadId: channel.threadId };
    await deps.prisma.$transaction(async (tx) => {
      await deps.delivery.recordIn(tx, lane, [
        {
          idempotencyKey: `intro:${channel.id}`,
          kind: "intro",
          threadId: channel.threadId,
          body: "Hi. This line hosts Rakazo personal agents. Some people in this group haven't messaged it yet; send any message to this line first if you want your own agent here.",
        },
      ]);
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { introPostedAt: new Date() },
      });
    });
    await deps.delivery.send([lane]);
  }

  // A service message (a pin, a join) carries nothing for a bot to read.
  if (!event.content.trim() && !event.mediaUrl && !event.attachments?.length) return;

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.messagingChannelMember.findUnique({
    where: { channelId_address: { channelId: channel.id, address: event.from } },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.messagingIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  const fromLabel = senderIdentity
    ? await ownerFirstName(deps.prisma, senderIdentity.userId, event.from)
    : event.from;

  const approved = await deps.prisma.messagingChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "channel_message",
    provider: event.provider,
    ...(event.transport ? { transport: event.transport } : {}),
    channelId: channel.id,
    fromAddress: event.from,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const prompt = `[Group "${channel.name ?? "group"}", ${fromLabel}]: ${event.content}`;
  for (const member of approved) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) continue;
    const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
    if (!thread) continue;
    const target = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      threadId: thread.id,
    };
    // One member's Space being deleted must not keep the message from the others.
    try {
      if (await wakeMessageRoutines(deps, target, event)) continue;
      // Group runs carry only text; a bare photo would start an empty prompt.
      if (!event.content.trim()) continue;

      const sent = await deps.events.sendUserMessage({
        spaceId: identity.spaceId,
        threadId: thread.id,
        botId: identity.botId,
        userId: identity.userId,
        blocks: [block],
        prompt,
        trigger: "messaging",
        clientNonce: `messaging:${event.provider}:${event.handle}`,
      });
      if (sent.runId) {
        await wakeRun(deps.jobs, sent.runId);
      }
    } catch (error) {
      droppedWhileDeleting(error);
    }
  }
}

type OutboundInvite = { idempotencyKey: string; kind: "dm"; identityId: string; body: string };

/**
 * A returning member restarts the approval cycle, so the invite replaces the prior one, which
 * would otherwise leave them with no prompt to answer.
 */
async function queueInvite(
  db: Pick<PrismaClient, "user">,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
  invites: OutboundInvite[],
): Promise<boolean> {
  // A deactivated person is not invited anywhere.
  if (await accountDeactivated(db, identity.userId)) return false;
  const name = channel.name ?? "a group chat";
  const idempotencyKey = `invite:${channel.id}:${identity.id}`;
  if (invites.some((invite) => invite.idempotencyKey === idempotencyKey)) return true;
  invites.push({
    idempotencyKey,
    kind: "dm",
    identityId: identity.id,
    body: `"${name}" was linked to your Rakazo agent. Reply YES to let your agent join the conversation there, or NO to stay out.`,
  });
  return true;
}

async function announceInvite(
  deps: MessagingInboundDeps,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<void> {
  const name = channel.name ?? "a group chat";
  const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
  if (thread) {
    const note = await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: `You were added to the group chat "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = displayName(user?.name, "").split(/\s+/)[0];
  return first ? sanitizeMessagingLabel(first) : fallback;
}
