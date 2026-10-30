import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The macOS screen driver ships as an extra resource, outside asar, so it can run. Only the
// pinned release is accepted: a changed or replaced download always fails the build. Other
// platforms have no driver yet. An offline local build skips it and screen control is absent.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(
  await readFile(path.join(root, "native", "screen-driver", "release.json"), "utf8"),
);
const out = path.join(root, "build", "screen-driver");
const stamp = path.join(out, ".sha256");

if (process.platform !== "darwin") process.exit(0);
if ((await readFile(stamp, "utf8").catch(() => "")) === release.sha256) process.exit(0);

let archive;
try {
  const response = await fetch(release.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
} catch (error) {
  if (process.env.RAKAZO_DESKTOP_RELEASE) throw error;
  console.warn(`Skipped the screen driver: ${error.message}`);
  process.exit(0);
}
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== release.sha256)
  throw new Error(`screen driver checksum mismatch: expected ${release.sha256}, got ${digest}`);

const staging = `${out}.partial`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const archivePath = path.join(staging, "release.tar.gz");
await writeFile(archivePath, archive);
const files = ["cua-driver", "LICENSE", "THIRD_PARTY_NOTICES.md"];
const tar = spawnSync(
  "tar",
  [
    "-xzf",
    archivePath,
    "-C",
    staging,
    "--strip-components",
    "1",
    ...files.map((file) => `${release.root}/${file}`),
  ],
  { stdio: "inherit" },
);
if (tar.status !== 0) process.exit(tar.status ?? 1);
await rm(archivePath);
await writeFile(path.join(staging, ".sha256"), release.sha256);
await rm(out, { recursive: true, force: true });
await rename(staging, out);
