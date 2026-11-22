// Decides whether a main push may ship as a mobile over-the-air update, for ci.yml's
// publish-mobile-update job. Runs on the runner's own Node before any install.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests, types, docs and device test flows never ship in the app.
function neverShips(file) {
  return (
    [".test.ts", ".test.tsx", ".test.js", ".d.ts", ".md"].some((suffix) => file.endsWith(suffix)) ||
    file.startsWith("apps/mobile/.maestro/") ||
    file.startsWith("apps/mobile/e2e/")
  );
}

// Only mobile bundle inputs may change. index.ts is the bundle entry the manifest's "main" names;
// the other top-level mobile scripts (app config, metro) shape the native build.
const BUNDLED = [
  {
    prefixes: ["apps/mobile/app/", "apps/mobile/components/", "apps/mobile/lib/"],
    files: ["apps/mobile/index.ts"],
    extensions: [".ts", ".tsx"],
  },
  {
    prefixes: ["packages/chat-ui/src/", "packages/ui-tokens/src/"],
    files: [],
    extensions: [".ts", ".tsx", ".css"],
  },
  {
    prefixes: ["packages/contracts/src/", "packages/core/src/", "packages/logging/src/"],
    files: [],
    extensions: [".ts", ".tsx"],
  },
];

const CATALOGS = "packages/i18n/locales/";
const CATALOG_IMPORTER = "apps/mobile/lib/i18n/i18n.ts";

function mobileCatalogs() {
  const source = readFileSync(new URL(`../../${CATALOG_IMPORTER}`, import.meta.url), "utf8");
  const imports = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(
      /^import \{ messages as \w+ \} from "@rakazo\/i18n\/(locales\/[\w-]+\/messages\.po)";\r?$/gm,
    );
  return new Set(Array.from(imports, ([, file]) => `packages/i18n/${file}`));
}

function isBundled({ status, file }, catalogs) {
  if (file.startsWith(CATALOGS)) return status === "M" && catalogs?.has(file);
  if (status !== "A" && status !== "M") return false;
  return BUNDLED.some(
    ({ prefixes, files, extensions }) =>
      (files.includes(file) || prefixes.some((prefix) => file.startsWith(prefix))) &&
      extensions.some((extension) => file.endsWith(extension)),
  );
}

export function otaEligibility(changes) {
  const shipped = changes.filter(({ file }) => !neverShips(file));
  // Only an unchanged importer proves the referenced catalog was already bundled at the base.
  const catalogs =
    shipped.some(({ status, file }) => status === "M" && file.startsWith(CATALOGS)) &&
    !shipped.some(({ file }) => file === CATALOG_IMPORTER)
      ? mobileCatalogs()
      : undefined;
  const blocked = shipped.filter((change) => !isBundled(change, catalogs)).map(({ file }) => file);
  return { publish: blocked.length === 0 && shipped.length > 0, blocked };
}

function parseChanges(input) {
  const parts = input.split("\0");
  if (parts.pop() !== "" || parts.length % 2 !== 0 || parts.includes("")) {
    throw new Error("Malformed mobile OTA diff");
  }
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) {
    changes.push({ status: parts[i], file: parts[i + 1] });
  }
  return changes;
}

export function otaSummary(base, { publish, blocked }) {
  const since = base.slice(0, 9);
  if (blocked.length > 0) {
    return [
      "### Mobile OTA skipped",
      "",
      `Since \`${since}\`, the last update installed builds run, these native-sensitive files changed:`,
      "",
      ...blocked.map((file) => `- \`${file}\``),
      "",
      "Ship new iOS and Android builds, or publish by hand once the JavaScript is confirmed safe on the current builds.",
      "",
    ].join("\n");
  }
  if (publish) {
    return [
      "### Mobile OTA eligible",
      "",
      `Since \`${since}\`, only the mobile bundle's JavaScript, TypeScript, stylesheets, or translation catalogs changed.`,
      "",
    ].join("\n");
  }
  return [
    "### No mobile OTA needed",
    "",
    `Nothing in the shipped mobile bundle changed since \`${since}\`.`,
    "",
  ].join("\n");
}

// Reads NUL-delimited status/path pairs from `git diff --name-status -z --no-renames` and appends
// the decision to the step summary file and the step's `publish` output file.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, summaryFile, outputFile] = process.argv.slice(2);
  const result = otaEligibility(parseChanges(readFileSync(0, "utf8")));
  appendFileSync(summaryFile, otaSummary(base, result));
  appendFileSync(outputFile, `publish=${result.publish}\n`);
}
