import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentRunModel, AgentRunRequest } from "@rakazo/adapter-kit";
import { readMessageBlocks } from "@rakazo/db";
import { nativeTextRuntime } from "../../providers/agent-runtime/claude/descriptor.js";

/** Deployment-owned allowlist. No user-supplied executable, environment or vendor fork. */
export function pilotRuntimeForBot(botId: string, environment = process.env): string | undefined {
  const allowed = environment.PRIMARY_RUNTIME_PILOT_BOT_IDS?.split(",").map((id) => id.trim());
  return allowed?.includes(botId) ? nativeTextRuntime.id : undefined;
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
) {
  const launcher = pilotLauncher();
  if (
    run.primaryRuntime !== nativeTextRuntime.id ||
    pilotRuntimeForBot(run.botId) !== run.primaryRuntime ||
    !launcher ||
    run.trigger !== "user" ||
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
