// Fails when a deployment's email copy directory would fall back anywhere: an unknown email or
// key, a missing key, or a string whose placeholders differ from its default. The production
// image build runs it under plain Node: node packages/auth/scripts/check-email-copy.ts <dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_COPY_DEFAULTS } from "../src/email-copy/defaults.ts";
import { readCopyFile } from "../src/email-copy/validate.ts";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: check-email-copy.ts <dir>");
const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
const problems = files.flatMap((file) => {
  try {
    return readCopyFile(
      EMAIL_COPY_DEFAULTS,
      file.slice(0, -".json".length),
      JSON.parse(readFileSync(join(dir, file), "utf8")),
    ).problems;
  } catch (error) {
    return [`${file}: ${error instanceof Error ? error.message : String(error)}`];
  }
});
for (const id of Object.keys(EMAIL_COPY_DEFAULTS))
  if (!files.includes(`${id}.json`)) problems.push(`${id}: no ${id}.json`);
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`Email copy in ${dir} covers every email.`);
