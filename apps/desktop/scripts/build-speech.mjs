import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The macOS dictation helper ships as an extra resource, outside asar, so it can run. It is
// one universal binary: the universal app build keeps a file that is already universal as is.
// Other platforms have no helper; a Mac without Swift builds the app and dictation falls back.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native", "speech");
const out = path.join(root, "build", "speech");
const helper = path.join(out, "rakazo-speech");
// Electron 45's own minimum.
const MACOS_TARGET = "12";

if (process.platform !== "darwin") process.exit(0);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const slices = [];
for (const arch of ["arm64", "x86_64"]) {
  const slice = path.join(out, `rakazo-speech-${arch}`);
  const result = spawnSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-swift-version",
      "5",
      "-target",
      `${arch}-apple-macos${MACOS_TARGET}`,
      path.join(source, "main.swift"),
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      path.join(source, "Info.plist"),
      "-o",
      slice,
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (result.status === 0) slices.push(slice);
  // Command Line Tools alone cannot link x86_64 for macOS 12; release builds verify both slices.
  else
    console.warn(`Skipped the ${arch} dictation helper: ${result.stderr?.trim() || result.error}`);
}

if (slices.length > 0) {
  const lipo = spawnSync("xcrun", ["lipo", "-create", "-output", helper, ...slices], {
    stdio: "inherit",
  });
  if (lipo.status !== 0) process.exit(lipo.status ?? 1);
}
await Promise.all(slices.map((slice) => rm(slice, { force: true })));
