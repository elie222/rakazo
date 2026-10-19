import type { PluginMarketplaceCatalog, PluginMarketplaceEntry } from "@rakazo/contracts";
import { z } from "zod";
import type { PluginTextReader } from "./plugin-connectors.js";
import { parsePluginSource } from "./plugin-connectors.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const REGISTRIES = [
  {
    name: "Cursor",
    repository: "https://github.com/cursor/plugins",
    path: ".cursor-plugin/marketplace.json",
  },
  {
    name: "xAI",
    repository: "https://github.com/xai-org/plugin-marketplace",
    path: ".grok-plugin/marketplace.json",
  },
];
const entrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  keywords: z.array(z.string().max(120)).max(50).optional(),
  source: z.union([
    z.string().max(2048),
    z.object({
      source: z.literal("url"),
      url: z.string().max(2048),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    }),
    z.object({ type: z.literal("local"), path: z.string().startsWith("./").max(2048) }),
  ]),
});

/** Public indexes are discovery hints, never installation authority. The
 * separate preview/digest gate validates and pins the selected package. */
export function parsePluginMarketplace(
  raw: string,
  registry: { name: string; repository: string },
): { entries: PluginMarketplaceEntry[]; skipped: number } {
  const index: unknown = JSON.parse(raw);
  if (
    !index ||
    typeof index !== "object" ||
    !("plugins" in index) ||
    !Array.isArray(index.plugins) ||
    index.plugins.length > 1000
  ) {
    throw new Error("Invalid marketplace index");
  }
  const entries: PluginMarketplaceEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const candidate of index.plugins) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const entry = parsed.data;
    try {
      const source = entry.source;
      const from =
        typeof source === "string"
          ? source.startsWith("https://")
            ? source
            : `${registry.repository}#${source.replace(/^\.\//, "")}`
          : "path" in source
            ? `${registry.repository}#${source.path.slice(2)}`
            : source.url;
      const ref = parsePluginSource(from);
      if (new URL(ref.gitUrl).hostname !== "github.com") throw new Error("Unsupported plugin host");
      if (typeof source !== "string" && "sha" in source && ref.ref && ref.ref !== source.sha)
        throw new Error("Conflicting plugin pin");
      const pin = typeof source !== "string" && "sha" in source ? source.sha : ref.ref;
      const suffix = ref.subdir ? `#${ref.subdir}` : "";
      const installedSource = ref.gitUrl + suffix;
      const installSource = ref.gitUrl + (pin ? `@${pin}` : "") + suffix;
      if (seen.has(installSource)) {
        skipped++;
        continue;
      }
      seen.add(installSource);
      entries.push({
        id: `${registry.name}:${installSource}`,
        name: entry.name,
        description: entry.description ?? "",
        keywords: entry.keywords ?? [],
        registry: registry.name,
        source: installSource,
        installedSource,
      });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

const publicRead: PluginTextReader = async (url, maxBytes, signal) =>
  (await fetchSafeWebText(url, { maxBytes, signal })).body;

/** Cache is per API router instance; failures are never cached. Concurrent
 * requests share one bounded fetch, without sharing an actor's abort signal. */
export function createPluginMarketplace(read: PluginTextReader = publicRead) {
  const cache = new Map<
    string,
    { expires: number; data: ReturnType<typeof parsePluginMarketplace> }
  >();
  const pending = new Map<string, Promise<ReturnType<typeof parsePluginMarketplace>>>();
  async function registryData(registry: (typeof REGISTRIES)[number]) {
    const cached = cache.get(registry.name);
    if (cached && cached.expires > Date.now()) return cached.data;
    const active = pending.get(registry.name);
    if (active) return active;
    const request = (async () => {
      const repo = new URL(registry.repository).pathname;
      const text = await read(
        `https://raw.githubusercontent.com${repo}/HEAD/${registry.path}`,
        2_000_000,
        AbortSignal.timeout(15_000),
      );
      if (Buffer.byteLength(text) > 2_000_000) throw new Error("Marketplace index is too large");
      const data = parsePluginMarketplace(text, registry);
      cache.set(registry.name, { data, expires: Date.now() + 60_000 });
      return data;
    })();
    pending.set(registry.name, request);
    try {
      return await request;
    } finally {
      pending.delete(registry.name);
    }
  }
  return {
    async catalog(query: string): Promise<PluginMarketplaceCatalog> {
      const results = await Promise.allSettled(REGISTRIES.map(registryData));
      const entries: PluginMarketplaceEntry[] = [];
      const unavailableRegistries: string[] = [];
      let skippedEntries = 0;
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") {
          entries.push(...result.value.entries);
          skippedEntries += result.value.skipped;
        } else unavailableRegistries.push(REGISTRIES[i]!.name);
      }
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      return {
        entries: entries
          .filter((entry) => {
            const text =
              `${entry.name} ${entry.description} ${entry.registry} ${entry.keywords.join(" ")}`.toLowerCase();
            return words.every((word) => text.includes(word));
          })
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        unavailableRegistries,
        skippedEntries,
      };
    },
  };
}
