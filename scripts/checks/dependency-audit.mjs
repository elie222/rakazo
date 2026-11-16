import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// pnpm 12 writes package-manager and workspace locks as separate YAML documents.
// Count package keys across every document; omitting either document must fail.
export function checkAuditCoverage(lockfile, report) {
  const counts = lockfile.split(/^---[ \t]*\r?$/m).map((document) => {
    let inPackages = false;
    let count = 0;
    for (const line of document.split("\n")) {
      if (/^\S/.test(line)) inPackages = line.trim() === "packages:";
      else if (inPackages && /^ {2}\S/.test(line)) count++;
    }
    return count;
  });
  const minimum = counts.reduce((total, count) => total + count, 0);
  assert(minimum > 0, "No lockfile package entries found; audit coverage cannot be checked");
  const actual = report.metadata?.totalDependencies;
  assert(
    Number.isInteger(actual) && actual >= minimum,
    `Incomplete dependency audit: expected at least ${minimum} packages, got ${actual}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkAuditCoverage(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
}
