import { createHash } from "node:crypto";
import { FLEET_WRITE_TOOL_NAMES, RUN_TRIGGERS } from "@rakazo/contracts";
import { HISTORY_FORMAT_VERSION } from "./pi-runtime-history.js";
import { messageToAgentHistoryText } from "./reply-context.js";
import {
  botEmailInstruction,
  dockerComputerToolInstruction,
  persistentComputerInstruction,
  runIdentityInstruction,
  userTurnInstructions,
  voiceCallInstruction,
} from "./run-instructions.js";
import { GROUP_UNADDRESSED_REPLY_GUIDANCE, runReplyGuidance } from "./run-replies.js";
import { CONTEXT_POLICY_SETTINGS } from "./runtime-context.js";

/**
 * Everything we change when tuning a bot's behavior, rendered from fixed placeholders: the system
 * prompt templates with every built-in tool offered, the reply-quote format, the history replay
 * format version and the context policy. Never reads user data, so it is the same on every run
 * of one release.
 */
export function promptVersionParts() {
  const bot = { name: "Bot", description: "Helps.", instructions: "Do the job." };
  return {
    historyFormat: HISTORY_FORMAT_VERSION,
    context: CONTEXT_POLICY_SETTINGS,
    computers: [true, false].flatMap((graphicalToolsAllowed) =>
      [true, false].map((graphical) =>
        persistentComputerInstruction({ heldForTakeover: false, graphicalToolsAllowed, graphical }),
      ),
    ),
    dockerComputer: dockerComputerToolInstruction("docker"),
    voiceCall: voiceCallInstruction(),
    identity: ["user", "created"].map((trigger) => runIdentityInstruction(bot, trigger)),
    email: botEmailInstruction("bot@example.com", { read: true, send: true, delete: true }),
    groupReply: GROUP_UNADDRESSED_REPLY_GUIDANCE,
    replies: [
      ...RUN_TRIGGERS.map((trigger) => runReplyGuidance(trigger)),
      runReplyGuidance("user", "messages"),
    ],
    replyQuote: messageToAgentHistoryText({
      id: "m2",
      threadId: "t",
      role: "user",
      blocks: [{ kind: "text", text: "Reply." }],
      replyTo: { id: "m1", threadId: "t", role: "bot", blocks: [{ kind: "text", text: "Hi." }] },
    }),
    instructions: (["connected", "offline"] as const).map((userComputer) =>
      userTurnInstructions({
        botInstructions: "",
        groupContext: undefined,
        messagingContext: undefined,
        redactedMemoryContext: undefined,
        redactedScratchpadContext: undefined,
        hasHistoricalContext: true,
        historyRetrievalEnabled: true,
        computerInstruction: "",
        pageBrowserAllowed: true,
        workspaceInstruction: "",
        agentEnvironmentInstruction: undefined,
        botDirectory: undefined,
        pluginLine: undefined,
        agentSkillsLine: "Skills.",
        taughtSkillsLine: undefined,
        replyGuidance: runReplyGuidance("user"),
        offeredFleetTools: FLEET_WRITE_TOOL_NAMES,
        followUpsOffered: true,
        backgroundHelpersAllowed: true,
        userComputer,
      }),
    ),
  };
}

export function promptVersionOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

/** Stored on each run, so outcomes can be compared between prompt and replay versions. */
export const PROMPT_VERSION = promptVersionOf(promptVersionParts());
