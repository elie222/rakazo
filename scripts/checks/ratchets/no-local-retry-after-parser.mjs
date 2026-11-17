export const message =
  "Do not parse a Retry-After header locally. Use parseRetryAfter(header, now) from @rakazo/core; if a caller needs a different cap, apply it at the call site.";

export const include = [
  "{packages/{adapters,core,db,auth,memory,logging},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-support.*",
  "**/testing/**",
  "packages/core/src/primitives/{async,retry,retry-policy}.ts",
];

const ANY_MENTION = /retry-?after/i;
// Reading the header: headers.get("retry-after") or headers["retry-after"]. Setting it is not.
const HEADER_READ = /(?:\.get\(\s*|\[\s*)["'`]retry-after["'`]\s*[)\]](?!\s*=[^=])/i;
const LOCAL_PARSER = /\b(?:function\s+|(?:const|let)\s+)parse\w*RetryAfter\w*\s*[=(<]/i;
const SHARED_PARSER = "parseRetryAfter(";

/** A file that reads the header and never hands it to the shared parser, or defines its own. */
export function count(text) {
  if (!ANY_MENTION.test(text)) return [];
  const definesParser = LOCAL_PARSER.test(text);
  const readsAreParsedHere = definesParser || !text.includes(SHARED_PARSER);
  return text.split("\n").flatMap((line, index) => {
    const hit = LOCAL_PARSER.test(line) || (readsAreParsedHere && HEADER_READ.test(line));
    return hit ? [{ line: index + 1, text: line.trim() }] : [];
  });
}
