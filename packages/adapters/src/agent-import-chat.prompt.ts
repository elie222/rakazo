/** Model-facing text of import_agents' refusals and result. */

export const AGENT_EXPORT_NOT_FOUND =
  "No agent export was found in the user's message or its attached files. Ask the user to paste the export in a message, or attach its file, then call import_agents again.";

export const AGENT_EXPORT_CHANGED =
  "The export is not the one the user approved. Ask the user to send it again.";

export const AGENT_IMPORT_RESULT_NOTE =
  "Every bot listed was created. Give the user one short summary per bot: what came over, what still needs them (routines are paused until they turn each on; webhook and Git routines need their source pointed at the address the routine shows; MCP servers wait for the user to approve them on the new bot's chat and sign in again), and what was left out and why.";

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
