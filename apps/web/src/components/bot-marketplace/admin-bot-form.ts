import type { MarketplaceBot } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";

export const BOT_CATEGORIES = ["personal", "engineering", "sales", "operations"] as const;

export type BotForm = {
  id: string;
  version: number;
  name: string;
  tagline: string;
  category: MarketplaceBot["category"];
  summary: string;
  /** One outcome per line. */
  outcomes: string;
  sample: string;
  instructions: string;
  description: string;
  intro: string;
  firstQuestion: string;
  authorName: string;
  authorUrl: string;
  license: string;
  homepage: string;
  setupMinutes: string;
  /** Comma or line separated. */
  tags: string;
  versionNote: string;
  /** Comma or line separated connection slugs. */
  apps: string;
  skills: { name: string; description: string; body: string }[];
  /** `crons` is one schedule per line. */
  routines: { name: string; prompt: string; crons: string }[];
};

export const MAX_SKILLS = 5;
export const MAX_ROUTINES = 5;

export function emptyForm(): BotForm {
  return {
    id: "",
    version: 1,
    name: "",
    tagline: "",
    category: "personal",
    summary: "",
    outcomes: "",
    sample: "",
    instructions: "",
    description: "",
    intro: "",
    firstQuestion: "",
    authorName: "BotONE Team",
    authorUrl: "",
    license: "Apache-2.0",
    homepage: "",
    setupMinutes: "",
    tags: "",
    versionNote: "",
    apps: "",
    skills: [],
    routines: [],
  };
}

export function formFromListing(listing: MarketplaceBot): BotForm {
  return {
    id: listing.id,
    version: listing.version,
    name: listing.name,
    tagline: listing.tagline,
    category: listing.category,
    summary: listing.summary,
    outcomes: listing.outcomes.join("\n"),
    sample: listing.sample,
    instructions: listing.instructions,
    description: listing.description,
    intro: listing.intro ?? "",
    firstQuestion: listing.firstQuestion ?? "",
    authorName: listing.author.name,
    authorUrl: listing.author.url ?? "",
    license: listing.license,
    homepage: listing.homepage ?? "",
    setupMinutes: listing.setupMinutes === undefined ? "" : String(listing.setupMinutes),
    tags: listing.tags.join(", "),
    versionNote: listing.versionNote ?? "",
    apps: listing.apps.join(", "),
    skills: listing.skills.map((skill) => ({ ...skill })),
    routines: listing.routines.map((routine) => ({ ...routine, crons: routine.crons.join("\n") })),
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

const items = (text: string, separator: RegExp) =>
  text
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
const lines = (text: string) => items(text, /\n/);
const words = (text: string) => items(text, /[,\n]/);
const optional = (text: string) => text.trim() || undefined;

/** The listing the form describes, checked by the same schema the server enforces. */
export function parseForm(form: BotForm) {
  return MarketplaceBotSchema.safeParse({
    id: form.id.trim(),
    version: form.version,
    name: form.name.trim(),
    summary: form.summary.trim(),
    sample: form.sample.trim(),
    description: form.description.trim(),
    instructions: form.instructions.trim(),
    skills: form.skills.map((skill) => ({
      name: skill.name.trim(),
      description: skill.description.trim(),
      body: skill.body.trim(),
    })),
    routines: form.routines.map((routine) => ({
      name: routine.name.trim(),
      prompt: routine.prompt.trim(),
      crons: lines(routine.crons),
    })),
    apps: words(form.apps),
    author: { name: form.authorName.trim(), url: optional(form.authorUrl) },
    license: form.license.trim(),
    category: form.category,
    tagline: form.tagline.trim(),
    outcomes: lines(form.outcomes),
    setupMinutes: form.setupMinutes.trim() === "" ? undefined : Number(form.setupMinutes),
    homepage: optional(form.homepage),
    tags: words(form.tags),
    versionNote: optional(form.versionNote),
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

/**
 * The first issue per field, keyed by the form field it belongs to: a list entry reports on the
 * text area that holds the list, and a skill or routine on the field inside it, such as
 * `skills.0.name`.
 */
export function issuesByField(
  issues: readonly (FormIssue & { path: readonly PropertyKey[] })[],
): Map<string, FormIssue> {
  const found = new Map<string, FormIssue>();
  for (const issue of issues) {
    const [head] = issue.path;
    const depth = head === "skills" || head === "routines" ? 3 : head === "author" ? 2 : 1;
    const key = issue.path.slice(0, depth).map(String).join(".");
    if (!found.has(key)) found.set(key, issue);
  }
  return found;
}
