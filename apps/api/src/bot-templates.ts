import type { BotTemplate } from "@rakazo/contracts";
import { BotTemplateSchema } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const FEATURED_SLUGS = [
  "early-stage-startup-job-scout",
  "websiteaudit",
  "cloud-file-mover",
  "coupon-finder",
  "controlled-english-explainer",
  "app-extension-builder",
  "signado-warm-lead-brief",
  "weekly-lead-export",
];

/** Shared by requests to one server; concurrent misses use the same fetch. */
export function createBotTemplateCatalog(fetch: typeof globalThis.fetch = globalThis.fetch) {
  let cached: BotTemplate[] = [];
  let expiresAt = 0;
  let pending: Promise<BotTemplate[]> | null = null;

  async function load(): Promise<BotTemplate[]> {
    try {
      const signal = AbortSignal.timeout(5_000);
      const response = await fetch("https://api.botdirectory.ai/api/bots", {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Bot directory unavailable");
      const payload = await readBoundedJsonResponse<unknown>(response, 1_000_000, signal);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("bots" in payload) ||
        !Array.isArray(payload.bots)
      ) {
        throw new Error("Invalid bot directory response");
      }
      const seen = new Set<string>();
      cached = payload.bots.flatMap((value: unknown) => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        const parsed = BotTemplateSchema.safeParse({
          slug: row.slug,
          name: row.name,
          description: row.description ?? "",
          instructions: row.prompt,
          featured: row.featured === true,
        });
        if (!parsed.success || seen.has(parsed.data.slug)) return [];
        seen.add(parsed.data.slug);
        return [parsed.data];
      });
      if (!cached.some((template) => template.featured)) {
        const picks = [
          ...FEATURED_SLUGS.flatMap((slug) => cached.filter((template) => template.slug === slug)),
          ...cached.filter((template) => !FEATURED_SLUGS.includes(template.slug)),
        ].slice(0, 8);
        const featured = new Set(picks.map((template) => template.slug));
        cached = cached.map((template) => ({ ...template, featured: featured.has(template.slug) }));
      }
      expiresAt = Date.now() + TTL_MS;
    } catch {
      // An optional catalog must never prevent manual creation or show an error row.
      cached = [];
      expiresAt = Date.now() + RETRY_MS;
    }
    return cached;
  }

  return (): Promise<BotTemplate[]> => {
    if (Date.now() < expiresAt) return Promise.resolve(cached);
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
}
