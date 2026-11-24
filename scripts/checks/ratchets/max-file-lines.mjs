import { isEvalFile, isTestFile } from "../file-kinds.mjs";

const SOURCE_LIMIT = 1000;

export const message = `A new source file may not exceed ${SOURCE_LIMIT} lines. Tests and evals are exempt. Split the file along its responsibilities; do not add it to the frozen list.`;

export const include = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,astro,css,py,sh,swift,kt}"];

export const exclude = ["apps/www/src/i18n/**"];

/** One hit for a source file over the limit. */
export function count(text, file) {
  if (isTestFile(file) || isEvalFile(file)) return [];
  let lines = text.endsWith("\n") || text === "" ? 0 : 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
  return lines > SOURCE_LIMIT
    ? [{ line: SOURCE_LIMIT + 1, text: `${lines} lines, limit ${SOURCE_LIMIT}` }]
    : [];
}
