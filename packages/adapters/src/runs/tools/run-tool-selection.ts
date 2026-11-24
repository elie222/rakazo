import {
  disabledBuiltinToolSet,
  FLEET_TOOL_NAMES,
  FLEET_WRITE_TOOL_NAMES,
} from "@rakazo/contracts";
import {
  approvalCardExpires,
  BACKGROUND_HELPER_TRIGGER,
  isBackgroundRunTrigger,
  isOwnerStartedRun,
} from "@rakazo/core";
import { selectCloudAgentTools } from "../../cloud-agents/cloud-agent-tools-select.js";
import { READ_MEETING_TRANSCRIPT } from "../../meetings/meeting-chat.tool-definition.js";
import { selectMemoryTools } from "../../memory/memory-tools.js";
import { filterImageReturningComputerTools } from "../../models/model-vision.js";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import { shellDescription } from "../../tools/builtin-computer.tool-definition.js";
import { searchHistoryThisChat } from "../../tools/builtin-memory.tool-definition.js";
import {
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  SCHEDULE_TOOL_NAMES,
} from "../../tools/schedule-tools.js";
import { SKILL_TOOL_NAMES } from "../../tools/skill-tools.js";
import {
  backgroundRunToolUnavailableReason,
  createdRunToolUnavailableReason,
  disabledBuiltinToolUnavailableReason,
  groupMessageBotUnavailableReason,
} from "./run-tool-selection.prompt.js";
import { USER_COMPUTER_SCREEN_TOOLS, USER_COMPUTER_TOOLS } from "./run-tools-user-computer.js";

export const READ_ONLY_AGENT_TOOLS = new Set([
  "computer_observe",
  "list_files",
  "list_fleet",
  "read_file",
  "read_history",
  READ_MEETING_TRANSCRIPT,
  "read_email",
  "list_calendars",
  "list_calendar_events",
  "list_reminders",
  "search_history",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "recall_memory",
  "reflect_memory",
  "schedule_list",
  "scratchpad_list",
  "board_tickets",
  "ticket_get",
  "skill_read",
  "web_search",
  "web_fetch",
  "service_search",
  "browser_snapshot",
  "list_secrets",
  "cloud_agent_status",
  "purchase_status",
]);

/**
 * All a routine with its owner's computer is offered: the owner's computer, the web and the owner's
 * own answers. Everything else could hand it text the owner did not approve (mail, files, memory,
 * history, tickets, skills, connectors, other bots) or reach stored state. Once the run reads the
 * web, the owner's computer asks before every call (see userComputerGate).
 */
const OWN_PROMPT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "user_computer_list",
  ...USER_COMPUTER_TOOLS,
  "web_search",
  "web_fetch",
  "ask_user",
]);

/** The bot's own inbox, offered only in its owner's runs outside groups and channels. */
const EMAIL_INBOX_TOOL_NAMES = new Set(["read_email", "delete_email"]);
const PAID_SERVICE_TOOL_NAMES = new Set(["service_search", "service_call"]);

/** Offered only to a user who connected a wallet. */
const PURCHASE_TOOL_NAMES = new Set(["request_purchase", "purchase_status", "paid_request"]);

export const BUILTIN_AGENT_TOOL_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));

const FLEET_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);

export const FLEET_WRITE_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_WRITE_TOOL_NAMES);

/**
 * The creation intro asks what the bot is for and records the answer on its own profile.
 * It must not act (shell, computer, scheduling, spawning another bot, ...) before the user
 * has said what it is for. Answering its question resumes it as the user's turn, with
 * every tool (see commitAnswerRunInput).
 */
const CREATED_RUN_TOOL_NAMES = new Set(["ask_user", "update_bot"]);

/** Messaging and media tools a background run is not offered (see selectBuiltinToolsForRun). */
const BACKGROUND_DROPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "message_user",
  "message_bot",
  "handoff_to_bot",
  "message_agent",
  "generate_image",
  "generate_video",
]);

/** Delegation stays one level deep; account settings and direct replies remain the parent's. */
export const SUBAGENT_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "run_subagent",
  "spawn_bot",
  "message_user",
  "call_user",
  "end_call",
  "request_takeover",
  "update_bot",
  "update_preferences",
  "feedback",
]);

/** Cross-owner agent connections only exist for chat-linked bots, in turns that can talk. */
export function offersAgentConnectionTools(options: {
  hasMessagingIdentity: boolean;
  crossSpaceCommunication: boolean;
  trigger: string;
}): boolean {
  return (
    options.hasMessagingIdentity &&
    options.crossSpaceCommunication &&
    !isBackgroundRunTrigger(options.trigger) &&
    options.trigger !== "created" &&
    options.trigger !== BACKGROUND_HELPER_TRIGGER
  );
}

export function selectBuiltinToolsForRun(options: {
  ticketBoardEnabled?: boolean;
  phoneCallsEnabled?: boolean;
  historyRetrievalEnabled?: boolean;
  /** See historyMyChatsAllowed; otherwise search_history offers only this chat. */
  historyMyChats?: boolean;
  /** A routine with its owner's computer: only OWN_PROMPT_ONLY_TOOLS. */
  ownPromptOnly?: boolean;
  meetingTranscriptsAvailable?: boolean;
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  semanticMemoryEnabled: boolean;
  /** The configured provider can forget individual facts. */
  semanticMemoryForgets?: boolean;
  /** The configured provider can answer a question from many memories. */
  semanticMemoryReflects?: boolean;
  cloudAgentEnabled?: boolean;
  cloudAgentCleanupEnabled?: boolean;
  /** The run's user connected a payment wallet. */
  paymentWalletEnabled?: boolean;
  mediaImagesEnabled?: boolean;
  mediaVideoEnabled?: boolean;
  /** The deployment configured paid data services. */
  paidServicesEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Hanging up is only offered to a turn the caller spoke on a live call. */
  voiceCall?: boolean;
  /** Built-in names this bot turned off. Unknown names are ignored. */
  disabledBuiltinTools?: readonly string[];
  fleetManagement?: boolean;
  /** False when the Space has no other bot to message. */
  hasTeammates?: boolean;
  /** The bot belongs to a group other than the one this run is in. */
  hasGroups?: boolean;
  /** A follow-up run whose source message the user wrote. */
  followUpFromUser?: boolean;
  /** The person who started this run has their desktop connected (see userComputerOwner). */
  userComputer?: boolean;
  /** Their connected desktop can look at and drive its apps. */
  userComputerScreen?: boolean;
  /** The bot has an email address and this run is its owner's own, outside any group or channel. */
  emailInbox?: boolean;
  /** This server receives email and the bot has no address yet. */
  emailClaimable?: boolean;
  /** The inbox may be read and this server can send email. */
  emailSend?: boolean;
}) {
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const ownerStartedRun = isOwnerStartedRun(
    options.trigger,
    Boolean(options.followUpFromUser),
    options.messagingChannelRun,
  );
  // Claiming is offered only in the owner's own chat, so once the bot claims an address there it
  // can read the mail that follows, such as a sign-up code, in the same run.
  const emailClaimOffered =
    Boolean(options.emailClaimable) &&
    ownerStartedRun &&
    !options.groupId &&
    !options.messagingChannelRun;
  const emailMailbox = Boolean(options.emailInbox) || emailClaimOffered;
  const builtins = options.historyMyChats
    ? builtinAgentTools
    : builtinAgentTools.map((tool) =>
        tool.name === "search_history" ? searchHistoryThisChat : tool,
      );
  const offered = selectCloudAgentTools(
    selectMemoryTools(
      filterBuiltinToolsForRun(
        filterBuiltinToolsForThread(
          filterPageBrowserTools(
            filterImageReturningComputerTools(builtins, options.graphicalToolsAllowed),
            options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
          ),
          options.groupId,
        ),
        options.trigger,
      ),
      options.semanticMemoryEnabled,
      Boolean(options.semanticMemoryForgets),
      Boolean(options.semanticMemoryReflects),
    ),
    Boolean(options.cloudAgentEnabled),
    Boolean(options.cloudAgentCleanupEnabled),
  ).filter(
    (tool) =>
      !disabled.has(tool.name) &&
      (options.trigger !== "created" || CREATED_RUN_TOOL_NAMES.has(tool.name)) &&
      (options.trigger !== BACKGROUND_HELPER_TRIGGER || !SUBAGENT_HIDDEN_TOOLS.has(tool.name)) &&
      // A run nobody is watching is offered them too; its writes wait for the owner's approval.
      (!FLEET_TOOL_NAMES_SET.has(tool.name) ||
        (Boolean(options.fleetManagement) &&
          (ownerStartedRun || approvalCardExpires(options.trigger)))) &&
      (ownerStartedRun || (tool.name !== "update_preferences" && tool.name !== "feedback")) &&
      (options.paymentWalletEnabled || !PURCHASE_TOOL_NAMES.has(tool.name)) &&
      (options.mediaImagesEnabled || tool.name !== "generate_image") &&
      (options.mediaVideoEnabled || tool.name !== "generate_video") &&
      (options.paidServicesEnabled || !PAID_SERVICE_TOOL_NAMES.has(tool.name)) &&
      // Alone in its Space a bot has nobody to message. A bot it creates gets its first task
      // from spawn_bot, and its reply starts a run that offers message_bot.
      (options.hasTeammates !== false || tool.name !== "message_bot") &&
      (options.hasGroups === true || tool.name !== "post_to_group") &&
      (options.ticketBoardEnabled ||
        (tool.name !== "board_tickets" && !tool.name.startsWith("ticket_"))) &&
      (!isBackgroundRunTrigger(options.trigger) || !BACKGROUND_DROPPED_TOOL_NAMES.has(tool.name)) &&
      (options.voiceCall || tool.name !== "end_call") &&
      (emailMailbox || !EMAIL_INBOX_TOOL_NAMES.has(tool.name)) &&
      ((emailMailbox && options.emailSend) || tool.name !== "send_email") &&
      (emailClaimOffered || tool.name !== "claim_email_address") &&
      (options.userComputer || tool.name !== "user_computer_shell") &&
      (options.userComputer || options.userComputerScreen || tool.name !== "user_computer_list") &&
      (options.userComputerScreen || !USER_COMPUTER_SCREEN_TOOLS.has(tool.name)) &&
      // Already on a call, or reached through a messaging channel that cannot ring.
      ((options.phoneCallsEnabled &&
        !options.groupId &&
        !options.voiceCall &&
        !options.messagingChannelRun &&
        !isBackgroundRunTrigger(options.trigger)) ||
        tool.name !== "call_user") &&
      (options.historyRetrievalEnabled ||
        !["search_history", "read_history"].includes(tool.name)) &&
      (!options.ownPromptOnly || OWN_PROMPT_ONLY_TOOLS.has(tool.name)) &&
      (options.meetingTranscriptsAvailable || tool.name !== READ_MEETING_TRANSCRIPT) &&
      (!options.messagingChannelRun ||
        (!SCHEDULE_TOOL_NAMES.has(tool.name) &&
          !SKILL_TOOL_NAMES.has(tool.name) &&
          ![
            "remember",
            "save_shared_memory",
            "delete_shared_memory",
            "remove_mcp_server",
            "save_memory",
            "recall_memory",
            "forget_memory",
            "reflect_memory",
            "task_catalog",
            "board_tickets",
          ].includes(tool.name) &&
          !tool.name.startsWith("scratchpad_") &&
          !tool.name.startsWith("ticket_"))),
  );
  return withShellScreenTool(offered);
}

/** Tools that open this bot's own screen, in the order the shell names them. */
const SCREEN_OPENING_TOOLS = ["computer_observe", "browser_snapshot"] as const;

/** The offered tool a graphical shell command is told to open the bot's screen with. */
export function screenOpeningTool(tools: readonly { name: string }[]) {
  const offered = new Set(tools.map((tool) => tool.name));
  return SCREEN_OPENING_TOOLS.find((name) => offered.has(name));
}

/** A text-only model has no computer_observe, so the shell points it at a tool it was offered. */
function withShellScreenTool<T extends { name: string; description?: string }>(tools: T[]): T[] {
  const screenTool = screenOpeningTool(tools);
  if (screenTool === SCREEN_OPENING_TOOLS[0]) return tools;
  const description = shellDescription(screenTool);
  return tools.map((tool) => (tool.name === "shell" ? { ...tool, description } : tool));
}

/**
 * Why each built-in this run was not offered is unavailable, for the model's use_tool error.
 * The first matching reason wins; a built-in dropped for another reason gets none.
 */
export function unavailableBuiltinToolReasons(
  options: {
    groupId: string | null;
    trigger: string;
    disabledBuiltinTools?: readonly string[];
  },
  offered: readonly { name: string }[],
): Record<string, string> {
  const offeredNames = new Set(offered.map((tool) => tool.name));
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const reasons: Record<string, string> = {};
  for (const name of BUILTIN_AGENT_TOOL_NAMES) {
    if (offeredNames.has(name)) continue;
    if (options.trigger === "created" && !CREATED_RUN_TOOL_NAMES.has(name)) {
      reasons[name] = createdRunToolUnavailableReason(name);
    } else if (disabled.has(name)) {
      reasons[name] = disabledBuiltinToolUnavailableReason(name);
    } else if (options.groupId && name === "message_bot") {
      reasons[name] = groupMessageBotUnavailableReason(offeredNames.has("handoff_to_bot"));
    } else if (isBackgroundRunTrigger(options.trigger) && BACKGROUND_DROPPED_TOOL_NAMES.has(name)) {
      reasons[name] = backgroundRunToolUnavailableReason(name);
    }
  }
  return reasons;
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}

/** The fleet tools this run was offered, the same decision as tool selection. */
export function offeredFleetTools(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name).filter((name) => FLEET_TOOL_NAMES_SET.has(name));
}

const FOLLOW_UP_TOOL_NAMES = [
  "scratchpad_add",
  "scratchpad_complete",
  "schedule_create",
  "schedule_cancel",
];

/**
 * Whether this run can set its own follow-ups. Only a conversation the owner started can tell
 * what is still open with them; a routine, webhook, channel, subagent or hand-off from another
 * bot cannot.
 */
export function followUpsOffered(
  tools: readonly { name: string }[],
  ownerStartedRun: boolean,
  trigger: string,
): boolean {
  return (
    ownerStartedRun &&
    trigger !== "routine" &&
    FOLLOW_UP_TOOL_NAMES.every((name) => tools.some((tool) => tool.name === name))
  );
}
