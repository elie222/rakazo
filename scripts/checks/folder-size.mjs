// How many code files sit directly in each folder. A folder past the limit mixes modules that
// should be grouped by topic, the same way a file past its line limit mixes responsibilities.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoFiles } from "./ratchets.mjs";

export const LIMIT = 40;
export const BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "folder-size.baseline.json",
);

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|astro|py|sh|swift|kt|c|h|m|mm|sql|prisma)$/;
// Generated output, migrations and vendored registry components are not organised by hand.
const IGNORED = [/\/generated\//, /\/migrations\//, /^packages\/ui-web\/src\/components\/ui\//];

/** Code files per folder (direct children only), for every tracked folder that has any. */
export function folderCounts(files) {
  const counts = new Map();
  for (const file of files) {
    if (!CODE.test(file) || IGNORED.some((pattern) => pattern.test(file))) continue;
    const folder = path.posix.dirname(file);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

/** Folders above the limit and their frozen count, if any. */
export function oversized(counts, baseline) {
  const over = [];
  for (const [folder, count] of counts) {
    const allowed = Math.max(LIMIT, Object.hasOwn(baseline, folder) ? baseline[folder] : 0);
    if (count > allowed) over.push({ folder, count, allowed });
  }
  return over.sort((a, b) => b.count - a.count);
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE, "utf8"));
}

/** Files in the working tree: a move counts before it is staged. */
export function trackedFiles(cwd) {
  return repoFiles(cwd).filter((file) => existsSync(path.join(cwd, file)));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--tighten") {
  const root = path.resolve(path.dirname(BASELINE), "../..");
  const counts = folderCounts(trackedFiles(root));
  const baseline = readBaseline();
  const next = {};
  for (const folder of Object.keys(baseline).sort()) {
    const count = counts.get(folder) ?? 0;
    if (count > LIMIT) next[folder] = Math.min(count, baseline[folder]);
  }
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
}
