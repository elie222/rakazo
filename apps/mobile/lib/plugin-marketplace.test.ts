import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  browsablePlugins,
  filterPlugins,
  gitImportParams,
  hasPluginConnector,
  managedPluginParams,
  pluginCategories,
  pluginSite,
  pluginSkillCount,
  skillPacks,
  sourceHref,
} from "./plugin-marketplace";

const entry = (overrides: Partial<PluginMarketplaceEntry>): PluginMarketplaceEntry => ({
  id: "id",
  name: "name",
  displayName: "Name",
  description: "",
  keywords: [],
  category: null,
  logo: null,
  homepage: null,
  domains: [],
  registry: "Cursor",
  source: "https://github.com/acme/plugins",
  installedSource: "https://github.com/acme/plugins",
  hasConnector: true,
  skillCount: 0,
  ...overrides,
});

it("uses the product's own site for an icon, never GitHub's", () => {
  expect(pluginSite(entry({ domains: ["cal.com"] }))).toBe("https://cal.com");
  expect(pluginSite(entry({ homepage: "https://sentry.io/for/ai" }))).toBe("https://sentry.io");
  expect(pluginSite(entry({ homepage: "https://github.com/acme/plugin" }))).toBeNull();
});

it("filters by category and matches word prefixes, including the category label", () => {
  const plugins = [
    entry({ id: "a", displayName: "Calcom", keywords: ["scheduling"], category: "productivity" }),
    entry({ id: "b", displayName: "Sentry", description: "Error monitoring", category: "ops" }),
  ];
  const label = (name: string) => (name === "ops" ? "Security & Ops" : name);
  expect(filterPlugins(plugins, "cal sched", null, label).map((row) => row.id)).toEqual(["a"]);
  expect(filterPlugins(plugins, "", "productivity", label).map((row) => row.id)).toEqual(["a"]);
  expect(filterPlugins(plugins, "secu", null, label).map((row) => row.id)).toEqual(["b"]);
  expect(filterPlugins(plugins, "error", "productivity", label)).toEqual([]);
});

it("lists only present categories in product order", () => {
  const plugins = [entry({ category: "ops" }), entry({ category: "productivity" })];
  expect(pluginCategories(plugins)).toEqual(["productivity", "ops"]);
});

it("links a pinned subfolder to its tree and names a pasted URL after its last segment", () => {
  expect(sourceHref("https://github.com/acme/plugins#calcom", "abc")).toBe(
    "https://github.com/acme/plugins/tree/abc/calcom",
  );
  expect(gitImportParams(" https://github.com/acme/neon/ ")).toEqual({
    source: "https://github.com/acme/neon",
    installedSource: "https://github.com/acme/neon",
    name: "neon",
  });
});

const app = {
  connectorId: "managed",
  slug: "vercel",
  name: "Vercel",
  logo: "https://example.test/vercel.svg",
  connected: false,
  noAuth: false,
};

it("lends a managed app its brand's skills and keeps skill packs out of Integrations", () => {
  const vercel = entry({ id: "vercel", name: "vercel", displayName: "Vercel", skillCount: 3 });
  const sentry = entry({ id: "sentry", displayName: "Sentry" });
  const pack = entry({ id: "pack", displayName: "Teaching", hasConnector: false, skillCount: 2 });
  const { plugins, pluginForApp } = browsablePlugins([vercel, sentry, pack], [app]);
  expect(plugins.map((row) => row.id)).toEqual(["sentry"]);
  expect([...pluginForApp.values()].map((row) => row.id)).toEqual(["vercel"]);
  expect(skillPacks([vercel, sentry, pack], "teach").map((row) => row.id)).toEqual(["pack"]);
  expect(managedPluginParams(vercel, app)).toMatchObject({
    name: "Vercel",
    logo: app.logo,
    managedConnectorId: "managed",
    managedSlug: "vercel",
  });
});

it("counts only the parts an install added", () => {
  const install = (parts?: string[]) =>
    ({
      id: "install",
      kind: "plugin",
      config: {
        ...(parts ? { parts } : {}),
        format: "grok",
        name: "calcom",
        version: null,
        description: "",
        author: null,
        homepage: null,
        repository: null,
        license: null,
        keywords: [],
        resolvedSha: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        skills: [{ name: "book", description: "" }],
        mcpServers: [],
        skipped: [],
      },
    }) as unknown as CapabilityInstall;
  expect(pluginSkillCount(install(["connector"]))).toBe(0);
  expect(hasPluginConnector(install(["connector"]))).toBe(true);
  expect(pluginSkillCount(install(["skills"]))).toBe(1);
  expect(hasPluginConnector(install(["skills"]))).toBe(false);
  expect(pluginSkillCount(install())).toBe(1);
  expect(hasPluginConnector(install())).toBe(true);
});
