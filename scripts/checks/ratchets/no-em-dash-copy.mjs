export const message =
  'Do not join clauses in UI copy with an em dash. Write two sentences, or use a period, comma or colon. A lone "—" as an empty-value placeholder is fine.';

export const include = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/mobile/{app,components,lib}/**/*.{ts,tsx}",
  "apps/desktop/src/**/*.{ts,tsx}",
  "packages/{i18n,ui-web,chat-ui,page-kit}/src/**/*.{ts,tsx}",
];

export const exclude = ["**/*.{test,spec}.*"];

const EM_DASH = /—|\\u2014|&mdash;/g;

// The translatable strings: <Trans> children, <Plural> props, and t`` / msg`` templates.
const MESSAGES =
  /<Trans\b[\s\S]*?<\/Trans>|<Plural\b[\s\S]*?\/>|\b(?:t|msg)`(?:\\[\s\S]|[^`\\])*`/g;

export function count(text) {
  const hits = [];
  for (const message of text.matchAll(MESSAGES)) {
    const dashes = message[0].match(EM_DASH) ?? [];
    if (dashes.length === 0 || isPlaceholder(message[0])) continue;
    const line = text.slice(0, message.index).split("\n").length;
    const firstLine = message[0].split("\n")[0].trim();
    for (const _ of dashes) hits.push({ line, text: firstLine.slice(0, 160) });
  }
  return hits;
}

/** A message that is nothing but the dash, as in t`—` for a missing value. */
function isPlaceholder(source) {
  const content = source.startsWith("<Trans")
    ? source.slice(source.indexOf(">") + 1, -"</Trans>".length)
    : source.startsWith("<Plural")
      ? null
      : source.slice(source.indexOf("`") + 1, -1);
  return content !== null && content.trim() !== "" && content.replace(EM_DASH, "").trim() === "";
}
