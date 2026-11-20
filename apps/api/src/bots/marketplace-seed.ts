import type { MarketplaceBot } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import { BOT_TEMPLATES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

type Catalog = Pick<
  MarketplaceBot,
  "category" | "tagline" | "outcomes" | "intro" | "firstQuestion"
>;

/** What the market adds to each built-in template: the copy a visitor reads before adding it. */
const CATALOG: Record<string, Catalog> = {
  "morning-briefing": {
    category: "personal",
    tagline: "Know what your day holds before you open your inbox.",
    outcomes: [
      "A short briefing every weekday at 7:30.",
      "Calendar, mail that needs you, weather and your topics in one message.",
      "Nothing is sent or changed for you.",
    ],
    intro:
      "I send you a short briefing every weekday morning. I only point things out; you decide what to do.",
    firstQuestion:
      "Which city should I use for the weather, and which topics do you want news about?",
  },
  "inbox-triage": {
    category: "personal",
    tagline: "Read only the email that needs you, with replies already drafted.",
    outcomes: [
      "New mail sorted into reply needed, for your information and low priority.",
      "A draft reply saved for everything that needs one.",
      "Nothing is sent, deleted or archived without your say.",
    ],
    intro:
      "I sort your new email twice every weekday and save a draft for anything that needs a reply. I never send, delete or archive mail on my own.",
  },
  "pr-reviewer": {
    category: "engineering",
    tagline: "A first review of every pull request waiting on you, before you open it.",
    outcomes: [
      "The most important points first, each with the file and line.",
      "A suggested verdict: approve, comment or request changes.",
      "Nothing is posted until you say so.",
    ],
    intro:
      "Every weekday morning I review the pull requests waiting on you. Paste any pull request link and I will review that one too.",
  },
  "topic-watch": {
    category: "personal",
    tagline: "A weekly digest of what changed on the topics and sites you follow.",
    outcomes: [
      "Only what is new since the last digest.",
      "A source link and age for every item.",
      "Topics with nothing new are named in one line.",
    ],
    intro: "Every Monday I send a digest of what changed on the topics and sites you follow.",
    firstQuestion: "Which topics and websites should I watch?",
  },
};

/** The built-in templates as market listings, authored by the project itself. */
export function starterListings(): MarketplaceBot[] {
  return BOT_TEMPLATES.map((template) => {
    const catalog = CATALOG[template.id];
    if (!catalog) throw new Error(`Starter listing for ${template.id} is missing`);
    return MarketplaceBotSchema.parse({
      ...template,
      ...catalog,
      author: { name: "BotONE Team" },
      license: "Apache-2.0",
    });
  });
}

type SeedDb = {
  marketplaceBot: {
    findMany: (args: { select: { slug: true } }) => Promise<{ slug: string }[]>;
    create: (args: { data: Prisma.MarketplaceBotCreateInput }) => Promise<unknown>;
  };
};

/**
 * Adds the starter listings the catalog does not have yet, as drafts unless `publish` is set.
 * A listing an operator already created or edited is never touched. Returns the slugs added.
 */
export async function seedMarketplace(
  db: SeedDb,
  options: { publish: boolean },
): Promise<string[]> {
  const existing = new Set(
    (await db.marketplaceBot.findMany({ select: { slug: true } })).map((row) => row.slug),
  );
  const added: string[] = [];
  for (const [index, listing] of starterListings().entries()) {
    if (existing.has(listing.id)) continue;
    await db.marketplaceBot.create({
      data: {
        slug: listing.id,
        version: listing.version,
        status: options.publish ? "published" : "draft",
        sortOrder: index * 10,
        listing: listing as unknown as Prisma.InputJsonValue,
        publishedAt: options.publish ? new Date() : null,
      },
    });
    added.push(listing.id);
  }
  return added;
}
