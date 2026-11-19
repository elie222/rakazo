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
/** A character that can continue an address, host or account, so a match must not touch one. */
const ADDRESS_CHAR = /[\p{L}\p{N}_%+@-]/u;
const MIN_PARTY_CHARS = 3;
const MIN_ACCOUNT_DIGITS = 5;
const MAX_PARTY_CHARS = 120;
const MAX_ARG_DEPTH = 6;
/** Enough for a batch's recipients without burying the reviewer's input. */
const MAX_TARGETS = 10;
/** How many of a call's targets are looked up, so a huge batch costs bounded work. */
const MAX_CHECKED_TARGETS = 40;
/** What a run keeps of the outside content it read, newest last. */
export const MAX_OUTSIDE_TEXT_CHARS = 400_000;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

type Target = { value: string; site?: string };

/** The targets in a call's arguments, normalized for comparison. A URL's target is its host. */
export function actionTargets(args: Record<string, unknown>): Target[] {
  const targets = new Map<string, Target>();
  const add = (target: Target) => targets.set(target.value, target);
  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > MAX_ARG_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) walk(child, childKey, depth + 1);
    } else if (typeof node === "number" && PARTY_KEY.test(key)) {
      // An account number typed as a number is still where the money goes.
      if (Number.isInteger(node) && String(Math.abs(node)).length >= MIN_ACCOUNT_DIGITS)
        add({ value: String(node) });
    } else if (typeof node === "string" && node.trim() && !FREE_TEXT_KEY.test(key)) {
      const value = node.trim();
      const site = urlSite(value);
      const emails = value.includes("@")
        ? value
            .split(TOKEN_SEPARATORS)
            .filter((token) => EMAIL.test(token))
            .map(normalize)
        : [];
      if (site) add({ value: new URL(value).hostname, site });
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
  const targets = actionTargets(args).slice(0, MAX_CHECKED_TARGETS);
  const ownerSites = targets.some((target) => target.site) ? sitesInText(words) : new Set();
  return targets
    .filter(
      ({ value, site }) =>
        containsWhole(sources.outsideText, value) &&
        !containsWhole(owner, value) &&
        !(site && ownerSites.has(site)),
    )
    .map(({ value }) => value)
    .slice(0, MAX_TARGETS);
}

/**
 * Whether `text` holds `value` as a whole address, host or name: `alice@corp.co` is not in
 * `alice@corp.com`, and `lumen.co` is not in `pay.lumen.com`. A trailing full stop ends a sentence.
 */
function containsWhole(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    const before = text[at - 1];
    const after = text[at + value.length];
    const next = text[at + value.length + 1];
    const touchesBefore = before !== undefined && (before === "." || ADDRESS_CHAR.test(before));
    const touchesAfter =
      after !== undefined &&
      (ADDRESS_CHAR.test(after) ||
        (after === "." && next !== undefined && ADDRESS_CHAR.test(next)));
    if (!touchesBefore && !touchesAfter) return true;
  }
  return false;
}

/** The text in outside content (a tool result, a message), normalized for `outsideOnlyTargets`. */
export function outsideTextOf(content: unknown): string {
  const parts: string[] = [];
  let length = 0;
  const keep = (text: string) => {
    parts.push(text);
    length += text.length + 1;
  };
  const walk = (node: unknown, depth: number) => {
    // Only the cap's worth is ever kept, so a huge result is not read past it.
    if (depth > MAX_ARG_DEPTH * 2 || length > MAX_OUTSIDE_TEXT_CHARS) return;
    if (typeof node === "string") keep(node);
    // An account number in a structured result can be a call's target too.
    else if (typeof node === "number") keep(String(node));
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
