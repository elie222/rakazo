export const message =
  "A comment may not excuse a shortcut (workaround, hack, TODO, FIXME, XXX). Do the real fix in this change, or open an issue and leave no marker in the code.";

export const include = [
  "{apps,packages,infra,scripts}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,astro,css,sql,swift,kt,gradle}",
  "{apps,packages,infra,scripts}/**/*.{sh,py,yaml,yml,toml}",
  "{apps,packages,infra,scripts}/**/Dockerfile*",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/e2e/**",
  "apps/www/src/i18n/**",
  "scripts/checks/ratchets/**",
];

// The tags are upper case only: lower-case "todo" is a ticket status and a Spanish word.
const HEDGE = String.raw`(?:\b(?:workarounds?|hacks?|hacky)\b|(?-i:\b(?:TODO|FIXME|XXX)\b))`;
// `//` after a colon is a URL, not a comment.
const SLASH_COMMENT = new RegExp(
  String.raw`(?:(?<!:)\/\/|\/\*|^\s*\*|<!--|^\s*--\s).*?${HEDGE}`,
  "i",
);
const HASH_COMMENT = new RegExp(String.raw`(?:^|\s)#.*?${HEDGE}`, "i");
const HASH_COMMENT_FILES = /\.(?:sh|py|ya?ml|toml)$|\/Dockerfile[^/]*$/;
const ANY_HEDGE = new RegExp(HEDGE, "i");

export function count(text, file) {
  if (!ANY_HEDGE.test(text)) return [];
  const comment = HASH_COMMENT_FILES.test(file) ? HASH_COMMENT : SLASH_COMMENT;
  return text
    .split("\n")
    .flatMap((line, index) => (comment.test(line) ? [{ line: index + 1, text: line.trim() }] : []));
}
