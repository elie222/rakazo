// Release decisions for .github/workflows/release-desktop.yml. Runs on the runner's own Node before
// any install, so it uses nothing beyond the standard library.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const ALL_PLATFORMS = [
  { os: "macos-26", artifact: "macos" },
  { os: "ubuntu-24.04", artifact: "linux" },
  { os: "windows-2022", artifact: "windows" },
];

export function checkReleaseTag({ refType, tag, version }) {
  if (refType !== "tag") {
    throw new Error("Desktop releases must run from a tag, including manual dispatches.");
  }
  if (!STABLE_TAG.test(tag)) {
    throw new Error("Desktop releases use the stable vMAJOR.MINOR.PATCH channel.");
  }
  if (tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match desktop version ${version}.`);
  }
}

function compareStableTags(a, b) {
  const [, ...left] = STABLE_TAG.exec(a);
  const [, ...right] = STABLE_TAG.exec(b);
  for (let i = 0; i < 3; i++) {
    // BigInt, so parts past Number.MAX_SAFE_INTEGER still compare exactly, as sort -V does.
    const [l, r] = [BigInt(left[i]), BigInt(right[i])];
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function checkNewerThanPublished(tag, publishedTags) {
  const latest = publishedTags
    .filter((published) => STABLE_TAG.test(published))
    .sort(compareStableTags)
    .at(-1);
  if (latest !== undefined && compareStableTags(tag, latest) <= 0) {
    throw new Error(`${tag} must be newer than published release ${latest}.`);
  }
}

export function releasePlatforms(macOnly) {
  if (macOnly === "true") return ALL_PLATFORMS.slice(0, 1);
  if (macOnly === "false" || macOnly === "") return ALL_PLATFORMS;
  throw new Error("DESKTOP_RELEASE_MAC_ONLY must be true or false.");
}

export function releaseNotes(changelog, version) {
  const heading = `## [${version}] - `;
  const lines = changelog.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let found = false;
  let notes = "";
  for (const line of lines) {
    if (line.startsWith(heading)) {
      found = true;
      continue;
    }
    if (found && line.startsWith("## ")) break;
    if (found) notes += `${line}\n`;
  }
  return notes;
}

function desktopVersion() {
  const manifest = path.join(repoRoot, "apps/desktop/package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

const commands = {
  // Prints the desktop version once the tag names it.
  "check-tag": ([refType, tag]) => {
    const version = refType === "tag" && STABLE_TAG.test(tag) ? desktopVersion() : "";
    checkReleaseTag({ refType, tag, version });
    return version;
  },
  // Reads the published stable release tags from stdin.
  "check-newer": ([tag]) => {
    checkNewerThanPublished(tag, readFileSync(0, "utf8").split("\n"));
    return undefined;
  },
  platforms: ([macOnly = ""]) => JSON.stringify(releasePlatforms(macOnly)),
  notes: ([version]) =>
    releaseNotes(readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8"), version),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...args] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    console.error(`Usage: desktop-release.mjs <${Object.keys(commands).join("|")}> [args]`);
    process.exit(2);
  }
  try {
    const output = command(args);
    if (output !== undefined) process.stdout.write(name === "notes" ? output : `${output}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
