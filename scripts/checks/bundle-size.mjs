// Fails when the code a user must load to start the app outgrows its budget. It measures what the
// web and desktop builds already wrote to dist, so it runs right after `pnpm build` (CI's
// "Production builds" job) and not in `pnpm checks`, which has no build.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUDGETS_FILE = "scripts/checks/bundle-size.budgets.json";
const LARGEST_SHOWN = 8;

// The entry HTML names the entry chunk, every chunk it imports statically (the bundler's
// modulepreload links) and the stylesheets, whatever hashes this build gave them. Lazily loaded
// chunks are not in it.
function webStartupFiles(dist) {
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  const files = new Set();
  for (const [tag, name] of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const attribute = (key) => tag.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1];
    const url = name === "script" ? attribute("src") : attribute("href");
    const loads = name === "script" || /^(modulepreload|stylesheet)$/.test(attribute("rel") ?? "");
    if (loads && url?.startsWith("/") && !url.startsWith("//")) files.add(url.slice(1));
  }
  return [...files];
}

const BUNDLES = {
  "web-startup": {
    label: "web startup (the JavaScript and CSS the app page loads before first paint, gzipped)",
    dist: "apps/web/dist",
    build: "pnpm --filter @rakazo/web build",
    files: webStartupFiles,
    size: (bytes) => gzipSync(bytes).length,
    fix: "Load the new code lazily with a dynamic import(), so it leaves the startup set",
  },
  "desktop-main": {
    label: "desktop main process (the bundle and preload scripts Electron loads at launch)",
    dist: "apps/desktop/dist",
    build: "pnpm --filter @rakazo/desktop build",
    files: () => ["launch.js", "main.js", "preload.cjs", "setup-preload.cjs"],
    size: (bytes) => bytes.length,
    fix: 'This bundle is one file, so a dynamic import() of bundled code does not shrink it. List a heavy, rarely used dependency under "external" in apps/desktop/scripts/build.mjs and load it with a dynamic import() where it is used, as electron-updater is',
  },
};

const kb = (bytes) =>
  `${(bytes / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kB`;

function measure(root, bundle) {
  const dist = path.join(root, bundle.dist);
  try {
    const files = bundle
      .files(dist)
      .map((file) => ({ file, bytes: bundle.size(readFileSync(path.join(dist, file))) }))
      .sort((a, b) => b.bytes - a.bytes);
    return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { missing: path.relative(root, error.path).split(path.sep).join("/") };
  }
}

/** Budgets are in kB (1000 bytes). Returns one line per bundle within budget, and the failures. */
export function checkBundleSizes(root, budgets) {
  const passed = [];
  const failures = [];
  for (const [name, bundle] of Object.entries(BUNDLES)) {
    const limit = budgets[name];
    if (typeof limit !== "number") {
      failures.push(`No budget for "${name}" in ${BUDGETS_FILE}.`);
      continue;
    }
    const measured = measure(root, bundle);
    if (measured.missing) {
      failures.push(
        `Cannot measure ${name}: ${measured.missing} is missing. Run the build first: ${bundle.build}`,
      );
    } else if (measured.bytes > limit * 1000) {
      failures.push(
        [
          `Over budget: ${name}, ${bundle.label}.`,
          `  Measured ${kb(measured.bytes)}, limit ${kb(limit * 1000)}, over by ${kb(measured.bytes - limit * 1000)}.`,
          "  Largest files:",
          ...measured.files
            .slice(0, LARGEST_SHOWN)
            .map(({ file, bytes }) => `    ${kb(bytes).padStart(11)}  ${bundle.dist}/${file}`),
          `  ${bundle.fix}, or raise "${name}" in ${BUDGETS_FILE} and give the reason in the PR.`,
        ].join("\n"),
      );
    } else {
      passed.push(`${name}: ${kb(measured.bytes)} of ${kb(limit * 1000)}`);
    }
  }
  return { passed, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budgets = JSON.parse(readFileSync(path.join(repoRoot, BUDGETS_FILE), "utf8"));
  const { passed, failures } = checkBundleSizes(repoRoot, budgets);
  for (const line of passed) console.log(line);
  for (const failure of failures) console.error(`\n${failure}`);
  if (failures.length > 0) process.exit(1);
}
