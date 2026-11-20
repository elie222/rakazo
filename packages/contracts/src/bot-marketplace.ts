import * as z from "zod";
import { BotTemplateSchema } from "./bots/bot-template.js";
import { BOT_NAME_MAX_LENGTH, BotSchema } from "./bots/bot.js";

/**
 * A marketplace listing: a reviewed bot template plus the catalog metadata the market shows.
 * Strict like the template it extends, with no field for keys, memory, history, models or
 * servers, so a listing cannot carry anything personal or secret. The intro is fixed copy the
 * operator writes; it is posted as the bot's first message without running a model.
 */
export const MarketplaceBotSchema = BotTemplateSchema.extend({
  author: z.strictObject({
    name: z.string().min(1).max(100),
    url: z.string().url().max(500).optional(),
  }),
  license: z.string().min(1).max(80),
  category: z.enum(["personal", "engineering", "sales", "operations"]),
  /** One line, result-oriented; the card's second line. */
  tagline: z.string().min(1).max(160),
  outcomes: z.array(z.string().min(1).max(240)).min(1).max(12),
  setupMinutes: z.number().int().min(1).max(240).optional(),
  homepage: z.string().url().max(500).optional(),
  tags: z.array(z.string().min(1).max(80)).max(30).default([]),
  versionNote: z.string().max(500).optional(),
  /** The bot's first message after install; absent means the bot stays silent. */
  intro: z.string().min(1).max(2000).optional(),
  /** Appended to the intro: the first thing the bot asks the user. */
  firstQuestion: z.string().min(1).max(500).optional(),
});
export type MarketplaceBot = z.infer<typeof MarketplaceBotSchema>;

/** The listing's id is its catalog slug; it never changes once created. */
const slug = MarketplaceBotSchema.shape.id;

export const MarketplaceBotStatusSchema = z.enum(["draft", "published", "unpublished"]);
export type MarketplaceBotStatus = z.infer<typeof MarketplaceBotStatusSchema>;

/** The template a listing installs as: market metadata stays out of the install pipeline. */
export function marketplaceBotTemplate(listing: MarketplaceBot) {
  return {
    id: listing.id,
    version: listing.version,
    name: listing.name,
    summary: listing.summary,
    sample: listing.sample,
    description: listing.description,
    instructions: listing.instructions,
    skills: listing.skills,
    routines: listing.routines,
    apps: listing.apps,
  };
}

export const MarketplaceBotCatalogInput = z.strictObject({
  query: z.string().trim().max(200).default(""),
  category: MarketplaceBotSchema.shape.category.optional(),
});

export const MarketplaceBotCatalogEntrySchema = z.object({
  slug,
  name: z.string(),
  tagline: z.string(),
  category: MarketplaceBotSchema.shape.category,
  /** The version a one-click install sends back. */
  version: z.number().int().positive(),
  featured: z.boolean(),
  sortOrder: z.number().int(),
  author: MarketplaceBotSchema.shape.author,
  apps: z.array(z.string()),
  /** The bot an earlier install made, while it exists. */
  botId: z.string().nullable(),
});
export type MarketplaceBotCatalogEntry = z.infer<typeof MarketplaceBotCatalogEntrySchema>;

export const MarketplaceBotCatalogSchema = z.object({
  entries: z.array(MarketplaceBotCatalogEntrySchema),
});

export const MarketplaceBotGetInput = z.strictObject({ slug });

export const MarketplaceBotListingSchema = z.object({
  listing: MarketplaceBotSchema,
  botId: z.string().nullable(),
});

export const MarketplaceBotInstallInput = z.strictObject({
  slug,
  /** The version the user saw. */
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
});

export const MarketplaceBotInstallOutput = z.object({
  bot: BotSchema,
  /** False when the listing's bot already existed and was returned instead. */
  created: z.boolean(),
});

/** One catalog row as the ops console sees it, drafts included. */
export const MarketplaceBotAdminRowSchema = z.object({
  slug,
  version: z.number().int().positive(),
  status: MarketplaceBotStatusSchema,
  featured: z.boolean(),
  sortOrder: z.number().int(),
  listing: MarketplaceBotSchema,
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MarketplaceBotAdminRow = z.infer<typeof MarketplaceBotAdminRowSchema>;

export const MarketplaceBotAdminListInput = z.strictObject({
  status: MarketplaceBotStatusSchema.optional(),
});

export const MarketplaceBotAdminCreateInput = z.strictObject({
  listing: MarketplaceBotSchema,
});

export const MarketplaceBotAdminUpdateInput = z.strictObject({
  slug,
  listing: MarketplaceBotSchema.optional(),
  featured: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const MarketplaceBotAdminSetStatusInput = z.strictObject({
  slug,
  status: z.enum(["published", "unpublished"]),
});

/** Import keys a marketplace bot is recorded under; agent imports cannot use them. */
export const BOT_MARKETPLACE_IMPORT_KEY_PREFIX = "marketplace:";

/** Sent as the error's `data.reason` when the listing changed after it was shown. */
export const BOT_MARKETPLACE_CHANGED = "listing_changed";

export function isBotMarketplaceChanged(error: unknown): boolean {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  return Boolean(
    data && typeof data === "object" && "reason" in data && data.reason === BOT_MARKETPLACE_CHANGED,
  );
}
