import { readFile } from "node:fs/promises";
import type { PluginCategory } from "@rakazo/core";
import { PLUGIN_CATEGORIES } from "@rakazo/core";
import { z } from "zod";
import { CATALOG_URL, SITE_URL } from "./site";

const IntegrationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  description: z.string(),
  logo: z.url().nullable(),
  categories: z.array(z.string()),
  auth: z.enum(["oauth", "key", "none"]),
  actions: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
});

const CatalogSchema = z.object({
  version: z.literal(1),
  integrations: z.array(IntegrationSchema).min(1),
});

export type Integration = z.infer<typeof IntegrationSchema>;

/** Published weekly by a private sync job. `CATALOG_URL` may point at another URL or a local file. */
async function loadCatalog(): Promise<Integration[]> {
  const source = process.env.CATALOG_URL?.trim() || CATALOG_URL;
  try {
    const text = /^https?:\/\//.test(source)
      ? await fetch(source).then((response) => {
          if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status}`);
          return response.text();
        })
      : await readFile(source, "utf8");
    return CatalogSchema.parse(JSON.parse(text)).integrations;
  } catch (error) {
    // Production must not ship an empty catalog; offline local builds just skip the app pages.
    if (process.env.VERCEL_ENV === "production") throw error;
    console.warn(`Integrations catalog unavailable: ${String(error)}`);
    return [];
  }
}

export const INTEGRATIONS_PATH = "/integrations/";

/** English twins of the app's category chips, so the site and the app sort apps the same way. */
export const CATEGORY_LABELS: Record<PluginCategory | "other", string> = {
  productivity: "Productivity",
  communication: "Communication",
  sales: "Sales & CRM",
  marketing: "Marketing",
  finance: "Finance",
  people: "Recruiting & HR",
  design: "Design",
  code: "Developer",
  data: "Data",
  ops: "Security & Ops",
  other: "Other",
};

/** Composio's own categories, folded into the app's. Anything unlisted is "other". */
const SOURCE_CATEGORIES: Record<PluginCategory, readonly string[]> = {
  productivity: [
    "productivity",
    "project management",
    "task management",
    "product management",
    "team collaboration",
    "documents",
    "notes",
    "spreadsheets",
    "file management & storage",
    "content & files",
    "documents & ocr",
    "signatures",
    "bookmark managers",
    "calendar",
    "scheduling & booking",
    "event management",
    "time tracking software",
    "forms & surveys",
    "video conferencing",
    "webinars",
    "transcription",
    "ai meeting assistants",
  ],
  communication: [
    "email",
    "team chat",
    "communication",
    "phone & sms",
    "notifications",
    "transactional email",
    "customer support",
    "support",
    "customer appreciation",
    "social media accounts",
  ],
  sales: [
    "crm",
    "sales & crm",
    "contact management",
    "ai sales tools",
    "people & contact data",
    "company data",
    "proposal & invoice management",
    "ecommerce",
    "commerce",
  ],
  marketing: [
    "marketing",
    "marketing automation",
    "email newsletters",
    "drip emails",
    "social media marketing",
    "ads & conversion",
    "seo & ai visibility",
    "url shortener",
    "reviews",
    "social & creator data",
  ],
  finance: ["accounting", "payment processing", "taxes", "fundraising", "market data"],
  people: ["human resources", "hr talent & recruitment"],
  design: [
    "images & design",
    "video & audio",
    "audio & speech",
    "media generation",
    "video generation",
    "website builders",
    "website & app building",
  ],
  code: ["developer tools", "model context protocol", "app builder", "internet of things"],
  data: ["analytics", "business intelligence", "dashboards", "databases"],
  ops: ["server monitoring", "it operations", "security & identity tools", "ai safety compliance detection"],
};

const CATEGORY_BY_SOURCE = new Map(
  PLUGIN_CATEGORIES.flatMap((category) =>
    SOURCE_CATEGORIES[category].map((source) => [source, category] as const),
  ),
);

export type CategoryId = PluginCategory | "other";

export function categoryOf(integration: Integration): CategoryId {
  for (const source of integration.categories) {
    const category = CATEGORY_BY_SOURCE.get(source);
    if (category) return category;
  }
  return "other";
}

const POPULAR_SLUGS = [
  "gmail",
  "googlecalendar",
  "slack",
  "notion",
  "github",
  "linear",
  "googledrive",
  "googlesheets",
  "hubspot",
  "outlook",
  "jira",
  "salesforce",
  "airtable",
  "asana",
  "stripe",
  "shopify",
  "figma",
  "zoom",
  "calendly",
  "dropbox",
  "intercom",
  "googledocs",
  "clickup",
  "twitter",
];

export const INTEGRATIONS = await loadCatalog();

const BY_SLUG = new Map(INTEGRATIONS.map((integration) => [integration.slug, integration]));

export const POPULAR_INTEGRATIONS = POPULAR_SLUGS.flatMap((slug) => BY_SLUG.get(slug) ?? []);

/** Composio slugs use underscores and leading underscores (`_1password`); URLs read better hyphenated. */
export function integrationUrlSlug(slug: string): string {
  return slug.replace(/^_+/, "").replaceAll("_", "-");
}

export function integrationPath(slug: string): string {
  return `${INTEGRATIONS_PATH}${integrationUrlSlug(slug)}/`;
}

/** Round down so the headline count stays true as the catalog shifts. */
export function integrationCountLabel(): string {
  const count = INTEGRATIONS.length;
  return count >= 1000 ? `${(Math.floor(count / 100) * 100).toLocaleString("en-US")}+` : String(count);
}

export function relatedIntegrations(integration: Integration, limit = 6): Integration[] {
  const category = categoryOf(integration);
  const popular = new Set(POPULAR_SLUGS);
  return INTEGRATIONS.filter(
    (candidate) => candidate.slug !== integration.slug && categoryOf(candidate) === category,
  )
    .toSorted(
      (a, b) =>
        Number(popular.has(b.slug)) - Number(popular.has(a.slug)) || b.actions.length - a.actions.length,
    )
    .slice(0, limit);
}

export const CHAT_CHANNELS = [
  { name: "Slack", slug: "slack" },
  { name: "WhatsApp", slug: "whatsapp" },
  { name: "Telegram", slug: "telegram" },
  { name: "iMessage", slug: null },
  { name: "Feishu / Lark", slug: null },
] as const;

export function integrationBreadcrumbs(integration: Integration) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Integrations", item: `${SITE_URL}${INTEGRATIONS_PATH}` },
      {
        "@type": "ListItem",
        position: 2,
        name: integration.name,
        item: `${SITE_URL}${integrationPath(integration.slug)}`,
      },
    ],
  };
}

export function integrationsMarkdown(): string {
  const lines = INTEGRATIONS.map(
    (integration) =>
      `- [${integration.name}](${SITE_URL}${integrationPath(integration.slug)}): ${CATEGORY_LABELS[categoryOf(integration)]}, ${integration.actions.length} actions`,
  );
  return `# Rakazo integrations

Rakazo bots can connect to ${INTEGRATIONS.length} apps. Ask a bot to connect one and approve the sign-in it sends.

${lines.join("\n")}
`;
}

export function integrationMarkdown(integration: Integration): string {
  const actions = integration.actions.map(
    (action) =>
      `- **${action.name}**${action.readOnly ? " (read-only)" : ""}${action.description ? `: ${action.description}` : ""}`,
  );
  return `# ${integration.name}

${integration.description}

Category: ${CATEGORY_LABELS[categoryOf(integration)]}. Connect from any Rakazo bot at ${SITE_URL}${integrationPath(integration.slug)}.

## Actions

${actions.join("\n")}
`;
}
