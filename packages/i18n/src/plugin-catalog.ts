import { i18n } from "@lingui/core";
import type { McpServerConnection } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";

/**
 * Plugin catalog text both apps show, kept here so it can't drift between them. Static
 * descriptors keep it in Lingui extraction.
 */

/** A plugin category's name, or the name itself when it is not one of ours. */
export function pluginCategoryLabel(name: string): string {
  switch (name as PluginCategory) {
    case "productivity":
      return i18n._({ id: "Productivity", message: "Productivity" });
    case "communication":
      return i18n._({ id: "Communication", message: "Communication" });
    case "sales":
      return i18n._({ id: "Sales & CRM", message: "Sales & CRM" });
    case "marketing":
      return i18n._({ id: "Marketing", message: "Marketing" });
    case "finance":
      return i18n._({ id: "Finance", message: "Finance" });
    case "people":
      return i18n._({ id: "Recruiting & HR", message: "Recruiting & HR" });
    case "design":
      return i18n._({ id: "Design", message: "Design" });
    case "code":
      return i18n._({ id: "Developer", message: "Developer" });
    case "data":
      return i18n._({ id: "Data", message: "Data" });
    case "ops":
      return i18n._({ id: "Security & Ops", message: "Security & Ops" });
    default:
      return name;
  }
}

/** How a saved MCP server's connection stands. */
export function mcpServerStatusLabel(state: McpServerConnection): string {
  switch (state) {
    case "disabled":
      return i18n._({ id: "Disabled", message: "Disabled" });
    case "needs_client":
      return i18n._({ id: "Needs an OAuth client ID", message: "Needs an OAuth client ID" });
    case "needs_sign_in":
      return i18n._({ id: "Needs sign-in", message: "Needs sign-in" });
    case "not_working":
      return i18n._({ id: "Not working", message: "Not working" });
    case "connected":
      return i18n._({ id: "Connected", message: "Connected" });
    case "not_connected":
      return i18n._({ id: "Not connected", message: "Not connected" });
  }
}
