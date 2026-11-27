import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentRunModel, AgentRunRequest } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { readMessageBlocks } from "@rakazo/db";
import { nativeTextRuntime } from "../../providers/agent-runtime/claude/descriptor.js";
import { primaryGroupHistory } from "./primary-group-continuity.js";

/** Deployment-owned allowlist. No user-supplied executable, environment or vendor fork. */
export function pilotRuntimeForBot(botId: string, environment = process.env): string | undefined {
  const allowed = environment.PRIMARY_RUNTIME_PILOT_BOT_IDS?.split(",").map((id) => id.trim());
  return allowed?.includes(botId) ? nativeTextRuntime.id : undefined;
}

/** Group enrolment is separate from the existing direct-chat rollout. */
export function groupPilotEnrolled(botId: string, environment = process.env) {
  return (
    environment.PRIMARY_RUNTIME_PILOT_GROUP_BOT_IDS?.split(",").some((id) => id.trim() === botId) ??
    false
  );
}

export function groupPilotRuntimeForBot(botId: string, environment = process.env) {
  return groupPilotEnrolled(botId, environment)
    ? pilotRuntimeForBot(botId, environment)
    : undefined;
}

/** Model-authored tasks are a separate opt-in from human group mentions. */
export function handoffPilotRuntimeForBot(botId: string, environment = process.env) {
  const allowed = environment.PRIMARY_RUNTIME_PILOT_HANDOFF_BOT_IDS?.split(",").some(
    (id) => id.trim() === botId,
  );
  return allowed ? groupPilotRuntimeForBot(botId, environment) : undefined;
}

export function groupHandoffNonce(sourceRunId: string) {
  return `group-handoff:${sourceRunId}`;
}

/** For this pilot, only a human-started Pi turn in the same live app group can delegate. */
export function pilotHandoffSourceWhere(input: {
  spaceId: string;
  threadId: string;
  userId: string;
  botId: string;
}) {
  const { spaceId, threadId, userId, botId } = input;
  return {
    spaceId,
    threadId,
    userId,
    botId,
    primaryRuntime: null,
    trigger: "user",
    routineId: null,
    sourceMessage: { threadId, role: "user", authorUserId: userId },
    thread: {
      botId: null,
      externalConversationId: null,
      group: {
        spaceId,
        archivedAt: null,
        members: {
          some: { botId, bot: { spaceId, userId, archivedAt: null } },
        },
      },
    },
  };
}

export function pilotLauncher(environment = process.env): string | undefined {
  const launcher = environment.PRIMARY_RUNTIME_PILOT_LAUNCHER;
  if (process.platform !== "linux" || !launcher || !isAbsolute(launcher)) return;
  try {
    accessSync(launcher, constants.X_OK);
    return launcher;
  } catch {
    return;
  }
}

export function pilotRunModel(
  runtimeId: string,
  bot: { modelProvider: string | null; modelId: string | null; modelCredentialId: string | null },
) {
  if (
    runtimeId !== nativeTextRuntime.id ||
    bot.modelProvider !== nativeTextRuntime.provider ||
    !bot.modelId ||
    !bot.modelCredentialId
  )
    return;
  return {
    primaryRuntime: runtimeId,
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    modelCredentialId: bot.modelCredentialId,
    modelPinned: true,
  } as const;
}

export async function loadPilotRuntime(
  run: {
    primaryRuntime: string;
    modelCredentialId: string | null;
    modelProvider: string | null;
    modelId: string | null;
    botId: string;
    trigger: string;
    routineId: string | null;
  },
  model: AgentRunModel,
  groupTurn = false,
) {
  const launcher = pilotLauncher();
  if (
    run.primaryRuntime !== nativeTextRuntime.id ||
    pilotRuntimeForBot(run.botId) !== run.primaryRuntime ||
    !launcher ||
    (run.trigger !== "user" &&
      !(
        groupTurn &&
        run.trigger === "follow_up" &&
        handoffPilotRuntimeForBot(run.botId) === run.primaryRuntime
      )) ||
    run.routineId ||
    run.modelProvider !== nativeTextRuntime.provider ||
    !run.modelCredentialId ||
    model.provider !== run.modelProvider ||
    model.id !== run.modelId ||
    model.connectionId !== run.modelCredentialId ||
    model.billing !== "api_key" ||
    !model.apiKey ||
    model.oauth ||
    model.callObserver ||
    model.apiProtocol ||
    model.headers ||
    model.accountId ||
    model.gatewayId ||
    model.projectId ||
    model.region ||
    model.zeroDataRetention ||
    (model.baseUrl &&
      !["https://api.anthropic.com", "https://api.anthropic.com/"].includes(model.baseUrl))
  )
    throw new Error("The selected primary runtime or its exact API-key connection is unavailable.");
  const { createNativeTextRuntime } = await nativeTextRuntime.load();
  return createNativeTextRuntime(launcher);
}

type PilotConversationMessage = Parameters<typeof readMessageBlocks>[0] & {
  id: string;
  seq: number;
  role: string;
  authorUserId: string | null;
  botId: string | null;
};

/** Reduces the provider input to the authorized app DM, never recalled/tool/attachment context. */
export function pilotConversation(
  run: { botId: string; userId: string; sourceMessageId: string | null },
  thread: { botId: string | null; groupId: string | null; externalConversationId: string | null },
  bot: { userId: string },
  messages: readonly PilotConversationMessage[],
): Pick<AgentRunRequest, "history" | "prompt"> {
  const source = messages.find((message) => message.id === run.sourceMessageId);
  if (
    thread.botId !== run.botId ||
    thread.groupId ||
    thread.externalConversationId ||
    bot.userId !== run.userId ||
    !source ||
    source.role !== "user" ||
    source.authorUserId !== run.userId
  )
    throw new Error("The primary runtime pilot only supports the bot owner's plain text chat.");
  const text = (message: PilotConversationMessage) => {
    const { blocks, intact } = readMessageBlocks(message);
    if (!intact || !blocks.length || blocks.some((block) => block.kind !== "text")) return "";
    return blocks
      .map((block) => (block.kind === "text" ? block.text : ""))
      .join("\n")
      .trim();
  };
  const prompt = text(source);
  if (!prompt) throw new Error("The primary runtime pilot needs a plain text message.");
  const history: AgentRunRequest["history"] = messages
    .filter(
      (message) =>
        message.seq < source.seq &&
        ((message.role === "user" && message.authorUserId === run.userId) ||
          (message.role === "bot" && message.botId === run.botId)),
    )
    .sort((a, b) => a.seq - b.seq)
    .flatMap((message) => {
      const content = text(message);
      return content
        ? [{ id: message.id, role: message.role === "user" ? "user" : "assistant", content }]
        : [];
    });
  return { prompt, history };
}

/** No ambient group history or instructions; only independently opted-in owner mentions can replay. */
export async function pilotGroupRequest(
  prisma: Pick<PrismaClient, "message" | "run">,
  input: {
    run: {
      id: string;
      botId: string;
      userId: string;
      spaceId: string;
      threadId: string;
      sourceMessageId: string | null;
      primaryRuntime: string;
      modelProvider: string | null;
      modelId: string | null;
      modelCredentialId: string | null;
      trigger: string;
      routineId: string | null;
    };
    thread: {
      id: string;
      botId: string | null;
      groupId: string | null;
      externalConversationId: string | null;
    };
    model: AgentRunModel;
    onUsage: AgentRunRequest["onUsage"];
    redactions: readonly string[];
  },
): Promise<AgentRunRequest> {
  const { run, thread, model, onUsage, redactions } = input;
  const handoff = run.trigger === "follow_up";
  const error = () =>
    new Error("The group runtime pilot requires authorized addressed text or a verified handoff.");
  if (
    !thread.groupId ||
    thread.botId ||
    thread.externalConversationId ||
    thread.id !== run.threadId ||
    !run.sourceMessageId ||
    (run.trigger !== "user" && !handoff) ||
    run.routineId ||
    (handoff ? handoffPilotRuntimeForBot(run.botId) : groupPilotRuntimeForBot(run.botId)) !==
      run.primaryRuntime
  )
    throw error();
  // Re-read live membership and the exact admitted source, never assembled history.
  const source = await prisma.message.findFirst({
    where: {
      id: run.sourceMessageId,
      threadId: run.threadId,
      authorUserId: handoff ? null : run.userId,
      role: handoff ? "bot" : "user",
      thread: {
        groupId: thread.groupId,
        spaceId: run.spaceId,
        externalConversationId: null,
        group: {
          spaceId: run.spaceId,
          archivedAt: null,
          members: {
            some: {
              botId: run.botId,
              bot: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
            },
          },
        },
      },
    },
    select: {
      id: true,
      threadId: true,
      seq: true,
      botId: true,
      runId: true,
      clientNonce: true,
      blocks: true,
    },
  });
  if (!source) throw error();
  const { blocks, intact } = readMessageBlocks(source);
  const [block] = blocks;
  if (!intact || blocks.length !== 1 || !block) throw error();
  let prompt: string;
  if (handoff) {
    if (
      block.kind !== "handoff" ||
      block.hop !== 1 ||
      !source.botId ||
      source.botId === run.botId ||
      block.fromBotId !== source.botId ||
      block.toBotId !== run.botId ||
      !source.runId ||
      source.clientNonce !== groupHandoffNonce(source.runId)
    )
      throw error();
    const origin = await prisma.run.findFirst({
      where: {
        ...pilotHandoffSourceWhere({ ...run, botId: source.botId }),
        id: source.runId,
        status: { in: ["running", "completed"] },
      },
      select: { id: true },
    });
    if (!origin) throw error();
    prompt = block.text;
  } else {
    if (block.kind !== "text") throw error();
    prompt = block.text;
  }
  if (!prompt.trim()) throw error();
  const continuity = process.env.PRIMARY_RUNTIME_PILOT_GROUP_CONTINUITY_BOT_IDS?.split(",").some(
    (id) => id.trim() === run.botId,
  );
  const history =
    !handoff && continuity && run.modelProvider && run.modelId && run.modelCredentialId
      ? await primaryGroupHistory(prisma, {
          ...run,
          modelProvider: run.modelProvider,
          modelId: run.modelId,
          modelCredentialId: run.modelCredentialId,
          beforeSeq: source.seq,
          redactions,
        })
      : [];
  return {
    botId: run.botId,
    threadId: run.threadId,
    runId: run.id,
    sourceMessageId: run.sourceMessageId,
    prompt: redactSecrets(prompt, redactions),
    instructions: "",
    history,
    tools: [],
    model,
    onUsage,
  };
}
