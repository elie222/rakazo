import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "esbuild";
import { build } from "esbuild";

const desktopRoot = path.resolve(import.meta.dirname, "..");

/**
 * A catalog file name is one language tag. This matches `isDesktopCatalogTag`
 * in `locale-catalog-file.ts`. Node runs this file directly and does not load that module.
 */
export function isDesktopCatalogTag(locale: string): boolean {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale);
}

/**
 * Writes one JSON file per non-English desktop catalog. The temporary bundle that
 * evaluates the TypeScript modules is deleted. It is not `dist/main.js`.
 */
export async function emitDesktopLocaleCatalogs(destination: string): Promise<readonly string[]> {
  const dest = path.resolve(destination);
  if (path.basename(dest) !== "locales") {
    throw new Error("desktop locale catalogs are written only to a locales directory");
  }
  const temp = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-locales-"));
  try {
    const outfile = path.join(temp, "catalogs.mjs");
    await build({
      absWorkingDir: desktopRoot,
      entryPoints: ["src/main/locale-catalogs.ts"],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      charset: "utf8",
      logLevel: "silent",
    });
    const imported = (await import(pathToFileURL(outfile).href)) as { CATALOGS?: unknown };
    if (!isRecord(imported.CATALOGS)) {
      throw new Error("locale-catalogs.ts did not export CATALOGS");
    }
    const catalogs = imported.CATALOGS;
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const tags = Object.keys(catalogs);
    for (const locale of tags) {
      const file = path.join(dest, `${locale}.json`);
      if (!isDesktopCatalogTag(locale) || path.dirname(file) !== dest) {
        throw new Error(`refusing to write a catalog whose tag is not a language tag: ${locale}`);
      }
      const messages = catalogMessages(locale, catalogs[locale]);
      writeFileSync(file, `${JSON.stringify(messages)}\n`);
    }
    return tags;
  } finally {
    rmSync(temp, { recursive: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogMessages(locale: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`desktop locale catalog ${locale} is not an object`);
  }
  const messages: Record<string, string> = {};
  for (const [key, message] of Object.entries(value)) {
    if (typeof message !== "string") {
      throw new Error(`desktop locale catalog ${locale} has a non-string value`);
    }
    messages[key] = message;
  }
  return messages;
}

/** The main bundle loads one catalog from `dist/locales` instead of embedding every language. */
export function desktopLocaleCatalogFiles(root: string, tags: readonly string[]): Plugin {
  return {
    name: "desktop-locale-catalog-files",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /(?:^|\/)locale-catalogs\.js$/ }, (args) => {
        if (args.kind === "entry-point") return null;
        return { path: args.path, namespace: "desktop-locale-catalog-files" };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "desktop-locale-catalog-files" }, () => ({
        contents: catalogLoaderSource(tags),
        loader: "js",
        resolveDir: path.join(root, "src", "main"),
      }));
    },
  };
}

function catalogLoaderSource(tags: readonly string[]): string {
  return `
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDesktopLocaleCatalog } from "./locale-catalog-file.js";

// One file beside this bundle: dist/locales/<locale>.json. Electron's fs reads it inside the asar.
// The first read is kept, including an unavailable file, so a missing catalog warns once.
const tags = ${JSON.stringify(tags)};
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const cache = new Map();

function catalog(locale) {
  if (cache.has(locale)) return cache.get(locale);
  const loaded = readDesktopLocaleCatalog(directory, locale, tags);
  cache.set(locale, loaded);
  return loaded;
}

export const CATALOGS = {};
for (const locale of tags) {
  Object.defineProperty(CATALOGS, locale, {
    enumerable: true,
    configurable: true,
    get() {
      return catalog(locale);
    },
  });
}
`;
}
