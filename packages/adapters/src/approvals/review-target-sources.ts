import { sitesInText, urlSite } from "@rakazo/core/egress";

/**
 * Where an action's targets came from, worked out by the server rather than asked of the reviewer.
 * A target is a recipient's address, a site the action reaches, or a payee or account named in
 * its arguments. One that outside content the run read (an email, page, file or tool result) holds
 * and the owner's own words do not was most likely chosen by that content, which the reviewer
 * cannot see.
 */

/** Keys whose values are what the action says or stores, not where it goes. */
const FREE_TEXT_KEY =
  /body|text|html|markdown|content|message|subject|description|reason|note|comment|title|summary|prompt|caption|query|instruction|values|rows|cells|records/i;
/** Keys that name who is paid or credited by name or account number rather than by address. */
const PARTY_KEY = /payee|merchant|vendor|beneficiary|iban|account|grantee/i;
/** Checked one token at a time, anchored, so a long argument is read in linear time. */
const EMAIL = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
const TOKEN_SEPARATORS = /[\s,;<>()[\]"'`]+/;
const MIN_PARTY_CHARS = 3;
const MAX_PARTY_CHARS = 120;
const MAX_ARG_DEPTH = 6;
/** Enough for a batch's recipients without burying the reviewer's input. */
const MAX_TARGETS = 10;
/** What a run keeps of the outside content it read, newest last. */
export const MAX_OUTSIDE_TEXT_CHARS = 400_000;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

type Target = { value: string; site?: string };

/** The targets in a call's arguments, normalized for comparison. A URL's target is its host. */
export function actionTargets(args: Record<string, unknown>): Target[] {
  const targets = new Map<string, Target>();
  const add = (target: Target) => targets.set(target.value, target);
  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > MAX_ARG_DEPTH || FREE_TEXT_KEY.test(key)) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) walk(child, childKey, depth + 1);
    } else if (typeof node === "string" && node.trim()) {
      const value = node.trim();
      const site = urlSite(value);
      const emails = value.includes("@")
        ? value
            .split(TOKEN_SEPARATORS)
            .filter((token) => EMAIL.test(token))
            .map(normalize)
        : [];
      if (site) add({ value: new URL(value).hostname.replace(/^www\./, ""), site });
      else if (emails.length) for (const email of emails) add({ value: email });
      else if (
        PARTY_KEY.test(key) &&
        value.length >= MIN_PARTY_CHARS &&
        value.length <= MAX_PARTY_CHARS
      )
        add({ value: normalize(value) });
    }
  };
  walk(args, "", 0);
  return [...targets.values()];
}

/**
 * The targets of a call that outside content holds and the owner's own words do not. `outsideText`
 * is what `appendOutsideText` kept of that content. A host the owner linked or named the site of
 * counts as the owner's.
 */
export function outsideOnlyTargets(
  args: Record<string, unknown>,
  sources: { ownerWords: readonly string[]; outsideText: string },
): string[] {
  if (!sources.outsideText) return [];
  const words = sources.ownerWords.join("\n");
  const owner = normalize(words);
  const targets = actionTargets(args);
  const ownerSites = targets.some((target) => target.site) ? sitesInText(words) : new Set();
  return targets
    .filter(
      ({ value, site }) =>
        sources.outsideText.includes(value) &&
        !owner.includes(value) &&
        !(site && ownerSites.has(site)),
    )
    .map(({ value }) => value)
    .slice(0, MAX_TARGETS);
}

/** The text in outside content (a tool result, a message), normalized for `outsideOnlyTargets`. */
export function outsideTextOf(content: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_ARG_DEPTH * 2) return;
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item, depth + 1);
    else if (node && typeof node === "object") {
      // An image's bytes hold no names.
      if ((node as { type?: unknown }).type === "image") return;
      for (const child of Object.values(node)) walk(child, depth + 1);
    }
  };
  walk(content, 0);
  return normalize(parts.join("\n"));
}

/** Adds newly read outside text to what a run keeps, dropping the oldest past the cap. */
export function appendOutsideText(kept: string, content: unknown): string {
  const text = outsideTextOf(content);
  if (!text.trim()) return kept;
  return (kept ? `${kept}\n${text}` : text).slice(-MAX_OUTSIDE_TEXT_CHARS);
}
