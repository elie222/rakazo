import { createHash } from "node:crypto";
import type { AgentRunModel, AgentRunRequest } from "@rakazo/adapter-kit";
import { isOneShotRoutineCrons, redactSecrets } from "@rakazo/core";
import type { Bot, PrismaClient, Routine, Thread } from "@rakazo/db";
import { accountDeactivated } from "@rakazo/db";
import { routineTimerScheduledFor } from "../../routines/routine-coalescing.js";
import { pilotRunModel, pilotRuntimeForBot } from "./primary-runtime-pilot.js";

/** An operator approves an identified routine's exact stored text, never a mutable name. */
export function routinePilotEnrollment(routineId: string, environment = process.env) {
  const entries = environment.PRIMARY_RUNTIME_PILOT_ROUTINES?.split(",").map((s) => s.trim());
  const matches = entries?.filter((entry) => entry.split(":")[0] === routineId);
  if (!matches?.length) return undefined;
  const digest = matches.length === 1 ? matches[0]?.split(":").slice(1).join(":") : undefined;
  // A malformed or duplicate assignment refuses instead of silently selecting Pi.
  return { digest: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : undefined };
}

type PilotRoutine = Pick<
  Routine,
  | "id"
  | "userId"
  | "spaceId"
  | "botId"
  | "threadId"
  | "prompt"
  | "crons"
  | "active"
  | "inChat"
  | "computerPromptHash"
  | "watch"
  | "webhookEnabled"
  | "githubEnabled"
  | "messageProvider"
  | "emailSenders"
  | "modelProvider"
  | "modelId"
  | "thinkingLevel"
> & {
  bot: Pick<
    Bot,
    "id" | "userId" | "spaceId" | "archivedAt" | "modelProvider" | "modelId" | "modelCredentialId"
  > & {
    thread: Pick<
      Thread,
      "id" | "userId" | "spaceId" | "botId" | "groupId" | "externalConversationId"
    > | null;
  };
};

export function pilotRoutineModel(
  routine: PilotRoutine,
  threadId: string,
  enrollment: ReturnType<typeof routinePilotEnrollment>,
) {
  const { bot } = routine;
  const thread = bot.thread;
  if (
    !enrollment?.digest ||
    !routine.active ||
    !routine.crons.length ||
    isOneShotRoutineCrons(routine.crons) ||
    routine.inChat ||
    routine.computerPromptHash ||
    routine.watch !== null ||
    routine.webhookEnabled ||
    routine.githubEnabled ||
    routine.messageProvider !== null ||
    routine.emailSenders !== null ||
    routine.modelProvider !== null ||
    routine.modelId !== null ||
    routine.thinkingLevel !== null ||
    !routine.prompt.trim() ||
    createHash("sha256").update(routine.prompt, "utf8").digest("hex") !== enrollment.digest ||
    bot.id !== routine.botId ||
    bot.userId !== routine.userId ||
    bot.spaceId !== routine.spaceId ||
    bot.archivedAt ||
    !thread ||
    thread.id !== threadId ||
    (routine.threadId !== null && routine.threadId !== threadId) ||
    thread.botId !== bot.id ||
    thread.userId !== routine.userId ||
    thread.spaceId !== routine.spaceId ||
    thread.groupId ||
    thread.externalConversationId
  )
    return;
  const runtime = pilotRuntimeForBot(bot.id);
  return runtime ? pilotRunModel(runtime, bot) : undefined;
}

export async function pilotRoutineRequest(
  prisma: Pick<PrismaClient, "routine" | "user">,
  run: {
    id: string;
    botId: string;
    userId: string;
    spaceId: string;
    threadId: string;
    trigger: string;
    routineId: string | null;
    clientNonce: string | null;
    sourceMessageId: string | null;
    retryOfRunId: string | null;
    primaryRuntime: string;
    modelProvider: string | null;
    modelId: string | null;
    modelCredentialId: string | null;
    modelPinned: boolean;
  },
  taskPrompt: string,
  model: AgentRunModel,
  onUsage: AgentRunRequest["onUsage"],
  redactions: readonly string[],
): Promise<AgentRunRequest> {
  const unavailable = () =>
    new Error("The selected primary runtime routine is no longer authorized.");
  const scheduledFor = run.routineId
    ? routineTimerScheduledFor(run.routineId, run.clientNonce)
    : undefined;
  if (
    run.trigger !== "routine" ||
    !run.routineId ||
    run.sourceMessageId ||
    run.retryOfRunId ||
    !run.modelPinned ||
    !scheduledFor
  )
    throw unavailable();
  const routine = await prisma.routine.findFirst({
    where: {
      id: run.routineId,
      botId: run.botId,
      userId: run.userId,
      spaceId: run.spaceId,
      space: { deletingAt: null, memberships: { some: { userId: run.userId } } },
    },
    include: { bot: { include: { thread: true } } },
  });
  if (
    !routine ||
    (routine.endsAt && scheduledFor > routine.endsAt) ||
    taskPrompt !== routine.prompt ||
    (await accountDeactivated(prisma, run.userId))
  )
    throw unavailable();
  const pin = pilotRoutineModel(routine, run.threadId, routinePilotEnrollment(routine.id));
  if (
    !pin ||
    pin.primaryRuntime !== run.primaryRuntime ||
    pin.modelProvider !== run.modelProvider ||
    pin.modelId !== run.modelId ||
    pin.modelCredentialId !== run.modelCredentialId
  )
    throw unavailable();
  return {
    runId: run.id,
    botId: run.botId,
    threadId: run.threadId,
    sourceMessageId: null,
    prompt: redactSecrets(taskPrompt, redactions),
    instructions: "",
    history: [],
    tools: [],
    model,
    onUsage,
  };
}
