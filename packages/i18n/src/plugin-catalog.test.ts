import { i18n } from "@lingui/core";
import { PLUGIN_CATEGORIES } from "@rakazo/core";
import { expect, it } from "vitest";
import { mcpServerStatusLabel, pluginCategoryLabel } from "./plugin-catalog";

it("names every plugin category and passes other names through", () => {
  i18n.activate("en");
  expect(pluginCategoryLabel("sales")).toBe("Sales & CRM");
  expect(pluginCategoryLabel("code")).toBe("Developer");
  expect(pluginCategoryLabel("other")).toBe("other");
  for (const name of PLUGIN_CATEGORIES) expect(pluginCategoryLabel(name)).not.toBe(name);
});

it("says how a saved server's connection stands", () => {
  i18n.activate("en");
  expect(mcpServerStatusLabel("needs_client")).toBe("Needs an OAuth client ID");
  expect(mcpServerStatusLabel("not_connected")).toBe("Not connected");
});
