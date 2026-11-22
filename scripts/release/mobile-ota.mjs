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

// Only bundled JavaScript and the translation catalogs Metro compiles into it may change. index.ts
// is the bundle entry the manifest's "main" names; the other top-level mobile scripts (app config,
// metro) shape the native build.
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
    prefixes: [
      "packages/contracts/src/",
      "packages/core/src/",
      "packages/i18n/src/",
      "packages/logging/src/",
    ],
    files: [],
    extensions: [".ts", ".tsx"],
  },
  { prefixes: ["packages/i18n/locales/"], files: [], extensions: [".po"] },
];

function isBundled(file) {
  return BUNDLED.some(
    ({ prefixes, files, extensions }) =>
      (files.includes(file) || prefixes.some((prefix) => file.startsWith(prefix))) &&
      extensions.some((extension) => file.endsWith(extension)),
  );
}

export function otaEligibility(files) {
  const shipped = files.filter((file) => file !== "" && !neverShips(file));
  const blocked = shipped.filter((file) => !isBundled(file));
  return { publish: blocked.length === 0 && shipped.length > 0, blocked };
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
      `Since \`${since}\`, only JavaScript, TypeScript, bundled CSS, or translation catalogs used by the mobile client changed.`,
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

// Reads the changed files from stdin, one per line, and appends the decision to the step summary
// file and the step's `publish` output file.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, summaryFile, outputFile] = process.argv.slice(2);
  const result = otaEligibility(readFileSync(0, "utf8").split("\n"));
  appendFileSync(summaryFile, otaSummary(base, result));
  appendFileSync(outputFile, `publish=${result.publish}\n`);
}
