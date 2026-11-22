// Fails when a deployment's email copy folder would leave an email unsent or falling back: a
// missing email, language or key, or a string whose placeholders differ from its key's. Copy this
// release does not use is listed without failing. Runs under plain Node:
// node packages/auth/scripts/check-email-copy.ts <dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_COPY_KEYS, EMAIL_LOCALES } from "../src/email-copy/email-keys.ts";
import { readCopyFile } from "../src/email-copy/validate.ts";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: check-email-copy.ts <dir>");
const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
const problems: string[] = [];
const unused: string[] = [];
for (const file of files) {
  try {
    const read = readCopyFile(
      EMAIL_COPY_KEYS,
      EMAIL_LOCALES,
      file.slice(0, -".json".length),
      JSON.parse(readFileSync(join(dir, file), "utf8")),
    );
    problems.push(...read.problems);
    unused.push(...read.unused);
  } catch (error) {
    problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const id of Object.keys(EMAIL_COPY_KEYS))
  if (!files.includes(`${id}.json`)) problems.push(`${id}: no ${id}.json`);
for (const entry of unused) console.log(`Unused: ${entry}`);
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`Email copy in ${dir} covers every email.`);
