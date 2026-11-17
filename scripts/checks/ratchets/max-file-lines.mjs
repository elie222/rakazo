const SOURCE_LIMIT = 1000;
const TEST_LIMIT = 1500;

export const message = `A new source file may not exceed ${SOURCE_LIMIT} lines, or ${TEST_LIMIT} for a test file. Split the file along its responsibilities; do not add it to the frozen list.`;

export const include = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,astro,css,py,sh,swift,kt}"];

export const exclude = ["apps/www/src/i18n/**"];

/** One hit for a file over its limit. Files over it today are frozen at 1, so they may still grow. */
export function count(text, file) {
  const limit = /(?:\.(?:test|spec)\.[^/]+|\/test_[^/]+\.py)$/.test(file)
    ? TEST_LIMIT
    : SOURCE_LIMIT;
  let lines = text.endsWith("\n") || text === "" ? 0 : 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
  return lines > limit ? [{ line: limit + 1, text: `${lines} lines, limit ${limit}` }] : [];
}
