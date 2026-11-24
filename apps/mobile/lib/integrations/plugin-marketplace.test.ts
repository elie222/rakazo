import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  gitImportParams,
  hasPluginConnector,
  managedPluginParams,
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

it("links a pinned subfolder to its tree and names a pasted URL after its last segment", () => {
  expect(sourceHref("https://github.com/acme/plugins#calcom", "abc")).toBe(
    "https://github.com/acme/plugins/tree/abc/calcom",
  );
  expect(sourceHref("https://github.com/acme/plugins", undefined)).toBe(
    "https://github.com/acme/plugins",
  );
  expect(sourceHref("example", undefined)).toBeNull();
  expect(sourceHref("javascript:alert(1)#x", "abc")).toBeNull();
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

it("lists skill packs for Skills and opens a brand's plugin as its managed app", () => {
  const vercel = entry({ id: "vercel", name: "vercel", displayName: "Vercel", skillCount: 3 });
  const sentry = entry({ id: "sentry", displayName: "Sentry" });
  const pack = entry({ id: "pack", displayName: "Teaching", hasConnector: false, skillCount: 2 });
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
