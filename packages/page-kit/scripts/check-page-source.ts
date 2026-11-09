/**
 * Checks a page file the way the API checks it, so a bot can gate a save before it sends the
 * page. Prints the validator's verdict as JSON and exits non-zero when the page is rejected.
 *
 *   tsx packages/page-kit/scripts/check-page-source.ts path/to/page.tsx
 */
import { readFileSync } from "node:fs";
import { checkPageSource } from "../src/validate.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx packages/page-kit/scripts/check-page-source.ts <file.tsx>");
  process.exit(2);
}
const result = checkPageSource(readFileSync(file, "utf8"));
if (result.ok) {
  console.log(JSON.stringify({ ok: true, file, warnings: result.warnings ?? [] }, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, file, errors: result.errors }, null, 2));
process.exit(1);
