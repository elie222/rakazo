import type { AgentImportSkipReason, AgentImportStatus } from "@rakazo/contracts";

/** Model-facing text of import_agents' refusals and result. */

export const AGENT_EXPORT_NOT_FOUND =
  "No agent export was found in the user's message or its attached files. Ask the user to paste the export in a message, or attach its file, then call import_agents again.";

export const AGENT_EXPORT_CHANGED =
  "The export is not the one the user approved. Ask the user to send it again.";

export const AGENT_IMPORT_FAILED =
  "This bot could not be imported because of a server error. Nothing was created for it; the user can try again.";

export const AGENT_IMPORT_RESULT_NOTE =
  "Bots with a botId were created; a bot with an error was not. Give the user one short summary per bot: what came over, what still needs them (routines are paused until they turn each on; webhook and Git routines need their source pointed at the address the routine shows; MCP servers wait for the user to approve them on the new bot's chat and sign in again), and what was left out and why.";

export function agentExportUnreadable(code: string): string {
  switch (code) {
    case "cut_off":
      return "The export is cut off. Ask the user to send the whole export, or all of its parts together.";
    case "too_large":
      return "The export is too large to import at once. Ask the user to send fewer bots per message.";
    case "newer_version":
      return "The export is in a newer format than this server reads.";
    default:
      return AGENT_EXPORT_NOT_FOUND;
  }
}

export function agentExportUnknownBots(missing: string[], available: string[]): string {
  return `The export has no bot named ${missing.map((name) => `"${name}"`).join(", ")}. Bots in it: ${available.map((name) => `"${name}"`).join(", ")}.`;
}

export function agentExportSharedName(name: string): string {
  return `The export has more than one bot named "${name}". Ask the user to import these in Settings, where they can pick each one.`;
}

export const LEFT_OUT_FOR_REVIEW = "looks like it contains a key, or is an unchanged default";
export const LEFT_OUT_BLOCKED = "cannot run here";
export const SERVER_ADDRESS_REFUSED = "this server refused its address";

const NEED_TEXT: Record<string, string> = {
  turn_on: "turn it on",
  credentials: "sign in again with",
  env: "set the variables",
  requires: "needs",
  local_paths: "uses paths on the user's computer",
  bundled_files: "uses files that were not imported",
  webhook: "point its source at the webhook address the routine shows",
  email_address: "give the bot an email address",
};

const SKIP_TEXT: Partial<Record<AgentImportSkipReason, string>> = {
  unsupported: "not supported here",
  reconnect: "connect it again here",
  invalid_skill: "not a readable skill",
  invalid_file: "could not be read",
};

export function skippedText(reason: AgentImportSkipReason): string {
  return SKIP_TEXT[reason] ?? reason;
}

/** What an imported item still needs, as the managing bot tells the user. */
export function importNeedsText(status: AgentImportStatus): string[] {
  if (status.kind !== "needs_setup") return [];
  return status.needs.map((need) => {
    switch (need.kind) {
      case "chat_app":
        return `connect the bot to ${need.provider}`;
      case "credentials":
      case "env":
      case "requires":
        return `${NEED_TEXT[need.kind]}: ${need.names.join(", ")}`;
      case "api_key":
        return `an API key for ${need.provider}`;
      case "program":
        return `the program ${need.name}`;
      default:
        return NEED_TEXT[need.kind] ?? need.kind;
    }
  });
}
