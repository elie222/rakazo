export const message =
  'Do not join clauses in UI copy with an em dash. Write two sentences, or use a period, comma or colon. A lone "—" as an empty-value placeholder is fine.';

export const include = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/mobile/{app,components,lib}/**/*.{ts,tsx}",
  "apps/desktop/src/**/*.{ts,tsx}",
  "packages/{i18n,ui-web,chat-ui,page-kit}/src/**/*.{ts,tsx}",
];

export const exclude = ["**/*.{test,spec}.*", "apps/desktop/src/main/locales/**"];

const EM_DASH = /—|\\u2014|&mdash;/g;

const STRING = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60`;

// The translatable strings: <Trans> children, <Plural> props, t`` and msg`` templates, and the
// strings passed to t(...), msg(...) or defineMessage(...), as in t("Save") or t({ message }).
const MESSAGES = new RegExp(
  [
    String.raw`<Trans\b[\s\S]*?<\/Trans>`,
    String.raw`<Plural\b[\s\S]*?\/>`,
    String.raw`\b(?:t|msg)\x60(?:\\[\s\S]|[^\x60\\])*\x60`,
    String.raw`\b(?:t|msg|defineMessage)\(\s*(?:${STRING}|\{[^}]*\})`,
  ].join("|"),
  "g",
);

export function count(text) {
  const hits = [];
  for (const match of text.matchAll(MESSAGES)) {
    const dashes = texts(match[0])
      .filter((copy) => copy.replace(EM_DASH, "").trim() !== "")
      .flatMap((copy) => copy.match(EM_DASH) ?? []);
    if (dashes.length === 0) continue;
    const line = text.slice(0, match.index).split("\n").length;
    const firstLine = match[0].split("\n")[0].trim().slice(0, 160);
    for (const _ of dashes) hits.push({ line, text: firstLine });
  }
  return hits;
}

/** The copy a message holds; one that is only the dash, as in t`—`, is a placeholder. */
function texts(source) {
  if (source.startsWith("<Trans"))
    return [source.slice(source.indexOf(">") + 1, -"</Trans>".length)];
  if (/^(?:t|msg)\x60/.test(source)) return [source.slice(source.indexOf("`") + 1, -1)];
  return (source.match(new RegExp(STRING, "g")) ?? []).map((literal) => literal.slice(1, -1));
}
