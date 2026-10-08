import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadIosScreenshotCatalog } from "../ios-screenshot-catalog.js";
import type { IosGallerySection } from "../ios-screenshot-gallery.js";
import { renderIosScreenshotGallery } from "../ios-screenshot-gallery.js";
import { seedIosScreenshotFixture } from "./ios-screenshot-seed.js";
import { runProcess } from "./process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CATALOG_DIR = path.join(ROOT, "apps", "mobile", "e2e", "ios-screenshots");

interface SectionResult {
  id: string;
  title: string;
  ok: boolean;
  screenshots: string[];
  error?: string;
}

async function main() {
  const requested = parseSections(process.argv.slice(2));
  const catalog = await loadIosScreenshotCatalog(CATALOG_DIR);
  const unknown = requested.filter((id) => !catalog.some((section) => section.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown section ${unknown.join(", ")}. Choose from: ${catalog.map((section) => section.id).join(", ")}`,
    );
  }
  const sections = requested.length
    ? catalog.filter((section) => requested.includes(section.id))
    : catalog;

  const udid = requiredEnv("SIM_UDID");
  const apiUrl = requiredEnv("RAKAZO_API_URL").replace(/\/$/, "");
  const databaseUrl = requiredEnv("DATABASE_URL");
  const email = requiredEnv("RAKAZO_SCREENSHOT_EMAIL");
  const emptyEmail = requiredEnv("RAKAZO_SCREENSHOT_EMPTY_EMAIL");
  const password = requiredEnv("RAKAZO_SCREENSHOT_PASSWORD");
  const outDir = path.resolve(
    process.env.IOS_SCREENSHOT_OUT || path.join(ROOT, "test-report", "ios-screenshots"),
  );

  await assertSafeOutputDirectory(outDir);
  await assertSimulatorBooted(udid);
  if (requested.length === 0) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const fixture = await seedIosScreenshotFixture({
    apiUrl,
    databaseUrl,
    email,
    emptyEmail,
    password,
  });

  const results: SectionResult[] = [];
  for (const section of sections) {
    const work = path.join(outDir, ".maestro", section.id);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      await runProcess(
        "maestro",
        [
          "--udid",
          udid,
          "test",
          "--no-ansi",
          "--flatten-debug-output",
          "--debug-output",
          path.join(work, "debug"),
          "--test-output-dir",
          path.join(work, "out"),
          "-e",
          `RAKAZO_SCREENSHOT_EMAIL=${email}`,
          "-e",
          `RAKAZO_SCREENSHOT_EMPTY_EMAIL=${emptyEmail}`,
          "-e",
          `RAKAZO_SCREENSHOT_PASSWORD=${password}`,
          "-e",
          `RAKAZO_SCREENSHOT_BOT_ID=${fixture.botId}`,
          "-e",
          `RAKAZO_SCREENSHOT_GROUP_ID=${fixture.groupId}`,
          "-e",
          `RAKAZO_SCREENSHOT_ROUTINE_ID=${fixture.routineId}`,
          path.join(CATALOG_DIR, section.flow),
        ],
        process.env,
      );
      results.push({
        id: section.id,
        title: section.title,
        ok: true,
        screenshots: await publishShots(work, path.join(outDir, section.id)),
      });
    } catch (_error) {
      results.push({
        id: section.id,
        title: section.title,
        ok: false,
        screenshots: await publishShots(work, path.join(outDir, section.id)).catch(() => []),
        error: "flow failed",
      });
    }
  }

  const gallery = await galleryFromDisk(outDir, catalog);
  await writeFile(path.join(outDir, "index.html"), renderIosScreenshotGallery(gallery));
  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(
      results.map(({ id, title, ok, screenshots }) => ({
        id,
        title,
        ok,
        count: screenshots.length,
        screenshots,
      })),
      null,
      2,
    )}\n`,
  );

  for (const result of results) {
    const status = result.ok ? "ok" : "failed";
    console.log(`${result.id}\t${status}\t${result.screenshots.length}`);
    if (result.error) console.log(`  ${result.error}`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

function parseSections(argv: string[]) {
  const sections: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") continue;
    if (arg === "--section") {
      const value = argv[index + 1];
      if (!value) throw new Error("--section needs a name");
      sections.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--section=")) {
      sections.push(arg.slice("--section=".length));
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  return sections;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function resolveOutputPath(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await resolveOutputPath(path.dirname(dir)), path.basename(dir));
  }
}

async function assertSafeOutputDirectory(outDir: string) {
  const resolved = await resolveOutputPath(outDir);
  const repo = await realpath(ROOT);
  const home = await realpath(homedir());
  const relative = path.relative(resolved, repo);
  if (
    resolved === path.parse(resolved).root ||
    resolved === home ||
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    throw new Error(
      "IOS_SCREENSHOT_OUT must not be a filesystem root, home, repository, or repository parent",
    );
  }
}

async function assertSimulatorBooted(udid: string) {
  const output = await promisify(execFile)("xcrun", ["simctl", "list", "devices", "booted"]);
  if (!output.stdout.includes(udid)) {
    throw new Error(
      "SIM_UDID is not booted. Boot that simulator before capturing. This command does not create or boot devices.",
    );
  }
}

async function publishShots(work: string, dest: string) {
  const found = new Map<string, string>();
  await walk(work, async (file) => {
    const name = path.basename(file);
    if (!/^\d{2}-[a-z0-9-]+\.png$/i.test(name)) return;
    found.set(name, file);
  });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const names = [...found.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const source = found.get(name);
    if (source) await copyFile(source, path.join(dest, name));
  }
  return names;
}

async function walk(dir: string, visit: (file: string) => Promise<void>) {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function galleryFromDisk(
  outDir: string,
  catalog: Awaited<ReturnType<typeof loadIosScreenshotCatalog>>,
): Promise<IosGallerySection[]> {
  const sections: IosGallerySection[] = [];
  for (const section of catalog) {
    let names: string[] = [];
    try {
      names = (await readdir(path.join(outDir, section.id)))
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      names = [];
    }
    sections.push({
      id: section.id,
      title: section.title,
      shots: names.map((name) => ({ name, src: `${section.id}/${name}` })),
    });
  }
  return sections;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
