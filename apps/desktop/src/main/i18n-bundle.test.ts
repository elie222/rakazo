import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopLocaleCatalogFiles,
  emitDesktopLocaleCatalogs,
} from "../../scripts/locale-catalogs.js";
import { CATALOGS } from "./locale-catalogs.js";
import { TH_MESSAGES } from "./locales/th.js";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const MARKER = "Check for Updates…";
const SPANISH = "Buscar actualizaciones…";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-locale-bundle-"));
  dirs.push(dir);
  return dir;
}

/** Bundles `i18n.ts` the way `scripts/build.mjs` does, with catalogs as sibling JSON files. */
async function bundleI18n(dir: string) {
  const tags = await emitDesktopLocaleCatalogs(path.join(dir, "locales"));
  const outfile = path.join(dir, "main.js");
  const result = await build({
    absWorkingDir: desktopRoot,
    entryPoints: ["src/main/i18n.ts"],
    outfile,
    bundle: true,
    charset: "utf8",
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [desktopLocaleCatalogFiles(desktopRoot, tags)],
    metafile: true,
    logLevel: "silent",
  });
  return { outfile, result, tags };
}

function localeInputBytes(inputs: Record<string, { bytes: number }>): number {
  return Object.entries(inputs)
    .filter(([file]) => file.includes("src/main/locales/") || file.endsWith("locale-catalogs.ts"))
    .reduce((sum, [, input]) => sum + input.bytes, 0);
}

describe("desktop locale bundle", () => {
  it("emits every catalog beside the bundle and keeps those bytes out of the bundle", async () => {
    const dir = await tempDir();
    const { outfile, result, tags } = await bundleI18n(dir);
    const localeFiles = readdirSync(path.join(desktopRoot, "src/main/locales"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.slice(0, -".ts".length))
      .sort();

    expect(tags).toEqual(Object.keys(CATALOGS));
    expect([...tags].sort()).toEqual(localeFiles);
    expect(localeFiles).not.toContain("en");
    for (const [locale, messages] of Object.entries(CATALOGS)) {
      const disk = JSON.parse(
        readFileSync(path.join(dir, "locales", `${locale}.json`), "utf8"),
      ) as unknown;
      expect(disk).toEqual(messages);
    }

    const source = readFileSync(outfile, "utf8");
    expect(localeInputBytes(result.metafile.inputs)).toBe(0);
    expect(source).not.toContain(SPANISH);
    expect(source).not.toContain("ตรวจสอบการอัปเดต");
    expect(
      Object.keys(result.metafile.inputs).some((file) => file.endsWith("locale-catalog-file.ts")),
    ).toBe(true);

    const packageJson = JSON.parse(
      readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as {
      build?: { files?: string[] };
    };
    expect(packageJson.build?.files).toContain("dist/**/*");
  });

  it("loads only the active catalog from disk, caches it, and falls back when the file is bad", async () => {
    const dir = await tempDir();
    const { result } = await bundleI18n(dir);
    expect(localeInputBytes(result.metafile.inputs)).toBe(0);
    const probe = path.join(dir, "probe.mjs");
    writeFileSync(probe, PROBE);
    const run = spawnSync(process.execPath, [probe], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as {
      started: string;
      es: string;
      esCount: number;
      plLocale: string;
      pl: string;
      plDir: string;
      plCount: number;
      esCachedLocale: string;
      esCached: string;
      enLocale: string;
      en: string;
      enCount: number;
      deLocale: string;
      de: string;
      deDir: string;
      thLocale: string;
      th: string;
      heSaved: string[];
      heLocale: string;
      heDir: string;
      heText: string;
    };

    expect(out.started).toBe("es");
    expect(out.es).toBe(SPANISH);
    expect(out.esCount).toBe(Object.keys(CATALOGS.es).length);
    expect(out.plLocale).toBe("en");
    expect(out.pl).toBe(MARKER);
    expect(out.plDir).toBe("ltr");
    expect(out.plCount).toBe(0);
    expect(out.esCachedLocale).toBe("es");
    expect(out.esCached).toBe(SPANISH);
    expect(out.enLocale).toBe("en");
    expect(out.en).toBe(MARKER);
    expect(out.enCount).toBe(0);
    expect(out.deLocale).toBe("en");
    expect(out.de).toBe(MARKER);
    expect(out.deDir).toBe("ltr");
    expect(run.stderr).toContain("desktop locale catalog unavailable: pl");
    expect(run.stderr).toContain("desktop locale catalog unavailable: de");
    expect(run.stderr).toContain("desktop locale catalog unavailable: he");
    expect(out.heSaved).toEqual(["he"]);
    expect(out.heSaved).not.toContain("en");
    expect(out.heLocale).toBe("en");
    expect(out.heDir).toBe("ltr");
    expect(out.heText).toBe(MARKER);
    expect(out.thLocale).toBe("th");
    expect(out.th).toBe(TH_MESSAGES[MARKER]);
  });
});

const PROBE = `
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bundled from "./main.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const marker = "Check for Updates…";
const out = {};

rmSync(path.join(dir, "pl.json"));
out.started = bundled.startDesktopLocale("es-MX", "en-US");
out.es = bundled.t(marker);
out.esCount = Object.keys(bundled.desktopMessages()).length;

out.plLocale = bundled.startDesktopLocale("pl-PL", "en-US");
out.pl = bundled.t(marker);
out.plDir = bundled.desktopDirection();
out.plCount = Object.keys(bundled.desktopMessages()).length;

writeFileSync(path.join(dir, "es.json"), "{");
out.esCachedLocale = bundled.startDesktopLocale("es", "en-US");
out.esCached = bundled.t(marker);

out.enLocale = bundled.startDesktopLocale("en", "es-ES");
out.en = bundled.t(marker);
out.enCount = Object.keys(bundled.desktopMessages()).length;

writeFileSync(path.join(dir, "de.json"), "not-json");
out.deLocale = bundled.startDesktopLocale("de-DE", "en-US");
out.de = bundled.t(marker);
out.deDir = bundled.desktopDirection();

const seen = [];
const handle = bundled.createLocaleHandler(
  async () => undefined,
  () => seen.push(bundled.t(marker)),
);
await handle(null, "th");
out.thLocale = bundled.desktopLocale();
out.th = seen[0] ?? "";

// he.json is gone. The page still reports Hebrew, so that choice is what gets saved.
// The window shows English, left to right, until the file can be read.
rmSync(path.join(dir, "he.json"));
const heSaved = [];
const saveHebrew = bundled.createLocaleHandler(
  async (locale) => {
    heSaved.push(locale);
  },
  () => undefined,
);
await saveHebrew(null, "he");
out.heSaved = heSaved;
out.heLocale = bundled.desktopLocale();
out.heDir = bundled.desktopDirection();
out.heText = bundled.t(marker);

process.stdout.write(JSON.stringify(out));
`;
