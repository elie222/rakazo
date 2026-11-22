import { i18n } from "@lingui/core";
import type { McpServerConnection } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";

/**
 * Plugin catalog text both apps show, kept here so it can't drift between them. Static
 * descriptors keep it in Lingui extraction.
 */

function categoryLabels(): Record<PluginCategory, string> {
  return {
    productivity: i18n._({ id: "Productivity", message: "Productivity" }),
    communication: i18n._({ id: "Communication", message: "Communication" }),
    sales: i18n._({ id: "Sales & CRM", message: "Sales & CRM" }),
    marketing: i18n._({ id: "Marketing", message: "Marketing" }),
    finance: i18n._({ id: "Finance", message: "Finance" }),
    people: i18n._({ id: "Recruiting & HR", message: "Recruiting & HR" }),
    design: i18n._({ id: "Design", message: "Design" }),
    code: i18n._({ id: "Developer", message: "Developer" }),
    data: i18n._({ id: "Data", message: "Data" }),
    ops: i18n._({ id: "Security & Ops", message: "Security & Ops" }),
  };
}

/** A plugin category's name, or the name itself when it is not one of ours. */
export function pluginCategoryLabel(name: string): string {
  return categoryLabels()[name as PluginCategory] ?? name;
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
