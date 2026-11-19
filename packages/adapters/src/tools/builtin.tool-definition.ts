import type { ConnectorTool } from "@rakazo/adapter-kit";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { meetingTranscriptTool } from "../meetings/meeting-chat.tool-definition.js";
import { computerTools } from "./builtin-computer.tool-definition.js";
import { conversationTools } from "./builtin-conversation.tool-definition.js";
import { fleetTools } from "./builtin-fleet.tool-definition.js";
import { memoryTools } from "./builtin-memory.tool-definition.js";
import { serviceTools } from "./builtin-services.tool-definition.js";
import { workTools } from "./builtin-work.tool-definition.js";

export const DELEGATION_TOOL_NAMES = new Set<string>([
  "run_subagent",
  "spawn_bot",
  "archive_bot",
  "handoff_to_bot",
  "message_bot",
  ...FLEET_TOOL_NAMES,
]);

export const builtinAgentTools: ConnectorTool[] = [
  ...computerTools,
  ...conversationTools,
  meetingTranscriptTool,
  ...serviceTools,
  ...memoryTools,
  ...workTools,
  ...fleetTools,
];

export const FIND_TOOL = "find_tool";
export const USE_TOOL = "use_tool";

/** The two tools that reach built-ins left out of the tool list; `nameIndex` lists those by area. */
export function bridgeToolDefinitions(nameIndex: string): ConnectorTool[] {
  return [
    {
      name: FIND_TOOL,
      description: `Get the parameters of built-in tools not in your tool list, including ones your instructions name. Call this before use_tool. Pass names for exact tools or query to search.\n${nameIndex}`,
      inputSchema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, maxItems: 5 },
          query: { type: "string", maxLength: 200, description: "Words describing the task" },
        },
      },
      readOnly: true,
    },
    {
      name: USE_TOOL,
      description: "Run a built-in tool whose parameters find_tool returned in this turn.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object", description: "Arguments matching its parameters" },
        },
        required: ["name", "arguments"],
      },
    },
  ];
}

/** The switch into computer mode for the main model, or back out of it for the computer model. */
export function computerModeToolDefinition(entering: boolean): ConnectorTool {
  const field = entering ? "goal" : "summary";
  return {
    name: entering ? "enter_computer_mode" : "leave_computer_mode",
    description: entering
      ? "Hand off a concrete GUI goal to computer mode before any browser or desktop action. Call this alone; computer mode continues in the same run."
      : "Finish computer work and return a summary to the main model in this same run. Call this alone.",
    inputSchema: {
      type: "object",
      properties: { [field]: { type: "string", minLength: 1 } },
      required: [field],
      additionalProperties: false,
    },
    readOnly: true,
  };
}

/** Agent-connection tools, exposed only when the messaging surface is enabled. */
export const agentConnectionTools: ConnectorTool[] = [
  {
    name: "connect_agent",
    description:
      "Request a standing connection to another person's agent by their owner's chat address. The other owner must approve before either agent can message the other. Only for agents whose owner messaged the deployment's chat line.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "The owner's address on the chat surface: an E.164 phone number (e.g. +15551234567) or platform user id.",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "respond_agent_connection",
    description:
      "Approve or decline the newest pending agent connection request addressed to you. Use only on your owner's explicit instruction.",
    inputSchema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "true to approve, false to decline." },
      },
      required: ["accept"],
    },
  },
  {
    name: "message_agent",
    description:
      "Send a useful update, question, or result to another person's agent over an approved connection. Delivery is async and does not end your turn. Continue independent work; do not poll or send ack-only messages.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "Chat address (phone number or platform user id) of the connected agent's owner.",
        },
        message: { type: "string", description: "What to send." },
      },
      required: ["address", "message"],
    },
  },
];

/** Shared documents are read by every bot, so a single save stays bounded. */
export const MAX_SHARED_MEMORY_CHARS = 4_000;

export function sharedMemorySaveError(args: Record<string, unknown>): string | undefined {
  const path = String(args.path ?? "").trim();
  if (!path) return "path is required";
  const content = String(args.content ?? "");
  if (content.length > MAX_SHARED_MEMORY_CHARS) {
    return `content exceeds ${MAX_SHARED_MEMORY_CHARS} characters`;
  }
  return undefined;
}
