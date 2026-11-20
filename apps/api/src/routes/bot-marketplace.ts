import { ORPCError } from "@orpc/server";
import type { Actor, MarketplaceBot, MarketplaceBotAdminRow } from "@rakazo/contracts";
import {
  BOT_MARKETPLACE_CHANGED,
  BOT_MARKETPLACE_IMPORT_KEY_PREFIX,
  MarketplaceBotSchema,
  marketplaceBotIntro,
  marketplaceBotTemplate,
} from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { managedAppCatalog } from "../account/onboarding.js";
import { requireAdmin } from "../auth/admins.js";
import { createBotFromTemplateDefinition } from "../bots/bot-templates.js";
import { marketplaceDraftFromBot, marketplaceSources } from "../bots/marketplace-source.js";
import type { RouterContext } from "./context.js";

type MarketplaceBotRow = {
  slug: string;
  version: number;
  status: string;
  featured: boolean;
  sortOrder: number;
  listing: Prisma.JsonValue;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function listingOf(row: MarketplaceBotRow): MarketplaceBot {
  return MarketplaceBotSchema.parse(row.listing);
}

function adminRow(row: MarketplaceBotRow): MarketplaceBotAdminRow {
  return {
    slug: row.slug,
    version: row.version,
    status: row.status as MarketplaceBotAdminRow["status"],
    featured: row.featured,
    sortOrder: row.sortOrder,
    listing: listingOf(row),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Key-order independent, so reformatting the JSON in the editor is not a content change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The listing without its version: the version records changes, it is not one. */
function listingContent(listing: MarketplaceBot): string {
  const { version: _version, ...content } = listing;
  return canonical(content);
}

function matchesQuery(listing: MarketplaceBot, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [listing.name, listing.tagline, listing.summary].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export function botMarketplaceRoutes(ctx: RouterContext) {
  const { deps, agentImportServices, authed } = ctx;

  /** Unpublished listings do not exist for users; drafts must not leak through errors. */
  async function publishedRow(slug: string): Promise<MarketplaceBotRow> {
    const row = await deps.prisma.marketplaceBot.findFirst({
      where: { slug, status: "published" },
    });
    if (!row) throw new ORPCError("NOT_FOUND", { message: "No bot has that slug." });
    return row;
  }

  /** The bot an earlier install made, while it exists, and the version it came from; per slug. */
  async function installedBots(
    actor: Actor,
    slugs: string[],
  ): Promise<Map<string, { botId: string; version: number | null }>> {
    if (!slugs.length) return new Map();
    const made = await deps.prisma.agentImport.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        importKey: { in: slugs.map((slug) => `${BOT_MARKETPLACE_IMPORT_KEY_PREFIX}${slug}`) },
        source: "marketplace",
        bot: { archivedAt: null },
      },
      select: { importKey: true, botId: true, sourceVersion: true },
    });
    return new Map(
      made.map((row) => [
        (row.importKey ?? "").slice(BOT_MARKETPLACE_IMPORT_KEY_PREFIX.length),
        { botId: row.botId, version: row.sourceVersion },
      ]),
    );
  }

  async function adminRowBySlug(slug: string): Promise<MarketplaceBotRow> {
    const row = await deps.prisma.marketplaceBot.findUnique({ where: { slug } });
    if (!row) throw new ORPCError("NOT_FOUND", { message: "No bot has that slug." });
    return row;
  }

  return {
    botMarketplace: {
      catalog: authed.botMarketplace.catalog.handler(async ({ context, input }) => {
        const rows = await deps.prisma.marketplaceBot.findMany({
          where: { status: "published" },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        });
        const matched = rows
          .map((row) => ({ row, listing: listingOf(row) }))
          .filter(
            ({ listing }) =>
              (!input.category || listing.category === input.category) &&
              matchesQuery(listing, input.query),
          );
        const bots = await installedBots(
          context.actor,
          matched.map(({ row }) => row.slug),
        );
        return {
          entries: matched.map(({ row, listing }) => ({
            slug: row.slug,
            name: listing.name,
            tagline: listing.tagline,
            category: listing.category,
            version: row.version,
            featured: row.featured,
            sortOrder: row.sortOrder,
            author: listing.author,
            apps: listing.apps,
            botId: bots.get(row.slug)?.botId ?? null,
          })),
        };
      }),
      get: authed.botMarketplace.get.handler(async ({ context, input }) => {
        const row = await publishedRow(input.slug);
        const made = (await installedBots(context.actor, [row.slug])).get(row.slug);
        return {
          listing: listingOf(row),
          botId: made?.botId ?? null,
          installedVersion: made?.version ?? null,
        };
      }),
      install: authed.botMarketplace.install.handler(async ({ context, input }) => {
        const row = await publishedRow(input.slug);
        const listing = listingOf(row);
        return createBotFromTemplateDefinition(
          agentImportServices,
          () => managedAppCatalog(deps.connectors, context.actor, "botMarketplace.install"),
          context.actor,
          marketplaceBotTemplate(listing),
          { version: input.version, name: input.name },
          {
            importKey: `${BOT_MARKETPLACE_IMPORT_KEY_PREFIX}${row.slug}`,
            source: "marketplace",
            changedReason: BOT_MARKETPLACE_CHANGED,
            digest: { marketplaceSlug: row.slug },
            intro: marketplaceBotIntro(listing),
          },
          context.signal,
        );
      }),
      admin: {
        list: authed.botMarketplace.admin.list.handler(async ({ context, input }) => {
          await requireAdmin(deps, context.actor.userId);
          const rows = await deps.prisma.marketplaceBot.findMany({
            where: input.status ? { status: input.status } : {},
            orderBy: { updatedAt: "desc" },
          });
          return rows.map(adminRow);
        }),
        create: authed.botMarketplace.admin.create.handler(async ({ context, input }) => {
          await requireAdmin(deps, context.actor.userId);
          const existing = await deps.prisma.marketplaceBot.findUnique({
            where: { slug: input.listing.id },
          });
          if (existing) {
            throw new ORPCError("CONFLICT", { message: "A bot with that slug already exists." });
          }
          // The row owns the version; the editor's copy starts at one.
          const listing = { ...input.listing, version: 1 };
          const row = await deps.prisma.marketplaceBot.create({
            data: {
              slug: listing.id,
              version: 1,
              status: "draft",
              listing: listing as unknown as Prisma.InputJsonValue,
              createdBy: context.actor.userId,
              updatedBy: context.actor.userId,
            },
          });
          return adminRow(row);
        }),
        update: authed.botMarketplace.admin.update.handler(async ({ context, input }) => {
          await requireAdmin(deps, context.actor.userId);
          const row = await adminRowBySlug(input.slug);
          let version = row.version;
          let listing = listingOf(row);
          if (input.listing) {
            if (input.listing.id !== row.slug) {
              throw new ORPCError("BAD_REQUEST", {
                message: "The slug cannot change; create a new bot instead.",
              });
            }
            // Any content change bumps the version so installs from an older view are refused.
            if (listingContent(input.listing) !== listingContent(listing)) version += 1;
            listing = { ...input.listing, version };
          }
          const updated = await deps.prisma.marketplaceBot.update({
            where: { slug: input.slug },
            data: {
              version,
              listing: listing as unknown as Prisma.InputJsonValue,
              ...(input.featured !== undefined ? { featured: input.featured } : {}),
              ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
              updatedBy: context.actor.userId,
            },
          });
          return adminRow(updated);
        }),
        setStatus: authed.botMarketplace.admin.setStatus.handler(async ({ context, input }) => {
          await requireAdmin(deps, context.actor.userId);
          const row = await adminRowBySlug(input.slug);
          const updated = await deps.prisma.marketplaceBot.update({
            where: { slug: input.slug },
            data: {
              status: input.status,
              publishedAt: input.status === "published" ? new Date() : row.publishedAt,
              updatedBy: context.actor.userId,
            },
          });
          return adminRow(updated);
        }),
        sources: authed.botMarketplace.admin.sources.handler(async ({ context }) => {
          await requireAdmin(deps, context.actor.userId);
          return marketplaceSources(deps.prisma, context.actor);
        }),
        fromBot: authed.botMarketplace.admin.fromBot.handler(async ({ context, input }) => {
          await requireAdmin(deps, context.actor.userId);
          return marketplaceDraftFromBot(deps.prisma, context.actor, input.botId);
        }),
      },
    },
  };
}
