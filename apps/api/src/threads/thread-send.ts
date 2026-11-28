import { ORPCError } from "@orpc/server";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import { nativeCalendarDeviceDigest } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { AttachmentValidationError, ClientError, MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { assertTeachingSendAllowed } from "../bots/taught-skills.js";
import type { RouterDeps } from "../router.js";
import { botsRunOwnModels, modelSetup } from "../routes/shared.js";
import { isStopMessage } from "./thread-stop.js";
import { replayExistingSend } from "./thread-strict-answer.js";
import { takeoverReleaser } from "./thread-takeover.js";
import {
  replyParentBotId,
  resolveThreadTarget,
  sendTargetBotIds,
  sendThreadMessage,
} from "./thread-target.js";

export type UserSendInput = Parameters<typeof sendThreadMessage>[3] & {
  botId?: string;
  groupId?: string;
  nativeCalendarDeviceKey?: string;
};

/**
 * A message the signed-in person sends into a chat, from the composer or on their behalf: the
 * model and teaching checks every such send passes before the message is saved and routed.
 */
export async function sendAsUser(
  deps: RouterDeps & { codexCatalog?: CodexLiveCatalog },
  actor: Actor,
  input: UserSendInput,
  startRoutines?: Parameters<typeof sendThreadMessage>[5],
  nativeSessionId?: string,
) {
  const target = await resolveThreadTarget(deps.prisma, actor, input);
  const releaseTakeover = takeoverReleaser(deps, actor, target);
  if (target.kind === "bot") {
    await assertTeachingSendAllowed(deps.prisma, actor.spaceId, target.botId);
  }
  // Strict card answers replay any saved receipt before checking model setup so a retry
  // after a lost HTTP response still returns its receipt if model lookup is unavailable.
  if (input.answersQuestion) {
    const replayed = await replayExistingSend(
      deps,
      target.threadId,
      actor.userId,
      input.clientNonce,
      releaseTakeover,
      input,
    );
    if (replayed) return replayed;
  }
  const setup = await modelSetup(deps, actor);
  // A bot with its own runnable model needs no main model, and stopping work needs none.
  const replied =
    target.kind === "group" ? await replyParentBotId(deps.prisma, target, input) : undefined;
  const noModel =
    setup.needsModel &&
    !(await botsRunOwnModels(deps, actor, sendTargetBotIds(target, input, replied)));
  if (noModel && (input.answersQuestion || !isStopMessage(input))) {
    throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
  }
  const confirmingImages = input.imageHandling === "confirm" && Boolean(input.artifactIds?.length);
  // Reuse the funding modelSetup resolved; a send never asks billing twice.
  const deployment = setup.hasDeployment
    ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
    : null;
  const deviceKey = nativeSessionId && target.kind === "bot" && input.nativeCalendarDeviceKey;
  return sendThreadMessage(
    {
      ...deps,
      maxAttachmentsPerMessage: deps.env.maxAttachmentsPerMessage,
      imageAdmission: confirmingImages
        ? {
            secrets: deps.secrets,
            deployment,
            hostedProvider: setup.creditsAvailable ? deployment?.provider : undefined,
            codexCatalog: deps.codexCatalog,
          }
        : undefined,
    },
    actor,
    target,
    {
      ...input,
      noModel,
      nativeCalendarSessionId: deviceKey ? nativeSessionId : undefined,
      nativeCalendarDeviceDigest: deviceKey ? nativeCalendarDeviceDigest(deviceKey) : undefined,
    },
    releaseTakeover,
    startRoutines,
  ).catch((error: unknown) => {
    if (error instanceof AttachmentValidationError) {
      throw new ClientError("BAD_REQUEST", error.message);
    }
    throw error;
  });
}

/** Thread events after which a task may read differently. Progress and activity change nothing. */
export const TASK_EVENTS: ReadonlySet<string> = new Set([
  "thread.message.created",
  "thread.message.updated",
  "thread.ask",
  "thread.choice",
  "run.started",
  "run.waiting_input",
  "computer.takeover.requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

/**
 * The person's own task for a message they sent, with the message's seq; null when it joined
 * someone else's. A send names the run that holds the chat, which in a shared Space can be
 * another member's; the message itself names its own run.
 */
export async function ownSentTask(
  prisma: PrismaClient,
  actor: Actor,
  sent: { threadId: string; clientNonce: string; taskId: string },
): Promise<{ taskId: string; seq: number | undefined } | null> {
  const message = await prisma.message.findFirst({
    where: { threadId: sent.threadId, clientNonce: sent.clientNonce },
    select: { runId: true, seq: true },
  });
  const run = message?.runId
    ? await prisma.run.findFirst({
        where: { id: message.runId, userId: actor.userId },
        select: { taskId: true },
      })
    : null;
  if (run) return { taskId: run.taskId, seq: message?.seq };
  const task = await prisma.task.findFirst({
    where: { id: sent.taskId, userId: actor.userId },
    select: { id: true },
  });
  return task ? { taskId: task.id, seq: message?.seq } : null;
}
