import type { MarketplaceBot, MarketplaceBotFromBot } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";

export const BOT_CATEGORIES = ["personal", "engineering", "sales", "operations"] as const;

/** What the operator writes or copies from a bot; the rest of a listing rides along in `base`. */
export type ListingForm = {
  name: string;
  category: MarketplaceBot["category"];
  /** The one line under the name. */
  tagline: string;
  /** What it does for users: one outcome per line. */
  outcomes: string;
  sample: string;
  intro: string;
  firstQuestion: string;
  /** Copied from the source bot. */
  description: string;
  instructions: string;
  skills: MarketplaceBot["skills"];
  routines: MarketplaceBot["routines"];
  /** Connection slugs the bot works with, separated by commas. */
  apps: string;
};

/** Listing fields the form does not edit: kept as they are when a listing is changed. */
export type ListingBase = Pick<
  MarketplaceBot,
  "id" | "version" | "summary" | "author" | "license" | "tags"
> &
  Partial<Pick<MarketplaceBot, "homepage" | "setupMinutes" | "versionNote">>;

export function newListing(): { form: ListingForm; base: ListingBase } {
  return {
    form: {
      name: "",
      category: "personal",
      tagline: "",
      outcomes: "",
      sample: "",
      intro: "",
      firstQuestion: "",
      description: "",
      instructions: "",
      skills: [],
      routines: [],
      apps: "",
    },
    base: {
      id: "",
      version: 1,
      summary: "",
      author: { name: "BotONE Team" },
      license: "Apache-2.0",
      tags: [],
    },
  };
}

export function listingFields(listing: MarketplaceBot): { form: ListingForm; base: ListingBase } {
  const { id, version, summary, author, license, tags, homepage, setupMinutes, versionNote } =
    listing;
  return {
    form: {
      name: listing.name,
      category: listing.category,
      tagline: listing.tagline,
      outcomes: listing.outcomes.join("\n"),
      sample: listing.sample,
      intro: listing.intro ?? "",
      firstQuestion: listing.firstQuestion ?? "",
      description: listing.description,
      instructions: listing.instructions,
      skills: listing.skills,
      routines: listing.routines,
      apps: listing.apps.join(", "),
    },
    base: {
      id,
      version,
      summary,
      author,
      license,
      tags,
      homepage,
      setupMinutes,
      versionNote,
    },
  };
}

/** The form with a bot's configuration copied in; its name too, unless someone chose one. */
export function copyFromBot(
  form: ListingForm,
  bot: MarketplaceBotFromBot,
  keepName: boolean,
): ListingForm {
  return {
    ...form,
    name: keepName ? form.name : bot.name,
    description: bot.description,
    instructions: bot.instructions,
    skills: bot.skills,
    routines: bot.routines,
  };
}

/** A catalog slug made from a name; empty when the name has no letters or digits to keep. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const words = (text: string) =>
  text
    .split(/[,\n]/)
    .map((word) => word.trim())
    .filter(Boolean);
const optional = (text: string) => text.trim() || undefined;

/**
 * The listing the form describes, checked by the schema the server enforces. A new listing's slug
 * comes from its name, or from `fallbackId` when the name has nothing a slug can keep.
 */
export function parseListing(form: ListingForm, base: ListingBase, fallbackId: string) {
  const tagline = form.tagline.trim();
  return MarketplaceBotSchema.safeParse({
    id: base.id || slugFromName(form.name) || fallbackId,
    version: base.version,
    name: form.name.trim(),
    summary: base.summary || tagline.slice(0, 120),
    sample: form.sample.trim(),
    description: form.description,
    instructions: form.instructions.trim(),
    skills: form.skills,
    routines: form.routines,
    apps: words(form.apps),
    author: base.author,
    license: base.license,
    category: form.category,
    tagline,
    outcomes: lines(form.outcomes),
    setupMinutes: base.setupMinutes,
    homepage: base.homepage,
    tags: base.tags,
    versionNote: base.versionNote,
    intro: optional(form.intro),
    firstQuestion: optional(form.firstQuestion),
  });
}

export type FormIssue = {
  code: string;
  format?: string;
  minimum?: unknown;
  message: string;
};

/** The first issue per top-level field of the listing, keyed by that field's name. */
export function issuesByField(
  issues: readonly (FormIssue & { path: readonly PropertyKey[] })[],
): Map<string, FormIssue> {
  const found = new Map<string, FormIssue>();
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (!found.has(key)) found.set(key, issue);
  }
  return found;
}
