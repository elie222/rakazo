import type { ConnectorEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { UNAVAILABLE_TOOL } from "../mcp/mcp-connector.tool-definition.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { unavailableInstalledTool } from "./installed-connectors.tool-definition.js";

type Install = { id: string; kind: string; name: string };

/** Logs why an installed source's tools could not be listed and returns the stand-in the
 * model sees in their place, so one unavailable source neither hides the other tools nor
 * looks as if it were not installed. */
export function installDiscoveryFailed(
  install: Install,
  catalogGroup: string,
  error: unknown,
  credential: string | undefined,
): ConnectorTool[] {
  const reason = sanitizeConnectorError(error, credential ? [credential] : []);
  getLogger().warn("installed connector discovery failed", {
    "connector.id": install.id,
    "connector.kind": install.kind,
    reason,
  });
  return [unavailableInstalledTool(install, catalogGroup, reason)];
}

/** Whether a call is for the stand-in of a source whose tools could not be listed. */
export function isUnavailableInstallCall(toolName: string | undefined): boolean {
  return toolName === UNAVAILABLE_TOOL;
}

/** What calling the stand-in answers. The reason is in the stand-in's own description:
 * it belongs to the turn that listed it, and the provider is shared across turns. */
export function unavailableInstallError(install: Install): ConnectorEvent {
  return {
    type: "error",
    message: `Installed source "${install.name}" could not list its tools on this turn, so none of them can be used yet. Tell the user it is temporarily unavailable and try again on a later turn.`,
  };
}
