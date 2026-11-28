import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "esbuild";
import { build } from "esbuild";
import type { CATALOGS } from "../src/main/locale-catalogs.js";

const desktopRoot = path.resolve(import.meta.dirname, "..");

export async function emitDesktopLocaleCatalogs(directory: string): Promise<string[]> {
  // Bundle the TypeScript data in memory so Node can load its .js specifiers.
  const {
    outputFiles: [output],
  } = await build({
    absWorkingDir: desktopRoot,
    entryPoints: ["src/main/locale-catalogs.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  if (!output) throw new Error("Desktop catalog build emitted no output");
  const source = Buffer.from(output.contents).toString("base64");
  const { CATALOGS: catalogs } = (await import(`data:text/javascript;base64,${source}`)) as {
    CATALOGS: typeof CATALOGS;
  };
  const entries = Object.entries(catalogs);
  for (const [locale] of entries) {
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
      throw new Error(`Invalid desktop catalog filename: ${locale}`);
    }
  }

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await Promise.all(
    entries.map(([locale, messages]) =>
      writeFile(path.join(directory, `${locale}.json`), JSON.stringify(messages)),
    ),
  );
  return Object.keys(catalogs);
}

export function desktopLocaleCatalogFiles(tags: readonly string[]): Plugin {
  return {
    name: "desktop-locale-catalog-files",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\.\/locale-catalogs\.js$/ }, ({ importer }) => {
        if (path.dirname(importer) !== path.join(desktopRoot, "src", "main")) return;
        return { path: "catalogs", namespace: "desktop-locale-catalog-files" };
      });
      pluginBuild.onLoad(
        { filter: /^catalogs$/, namespace: "desktop-locale-catalog-files" },
        () => ({
          contents: `
          export const desktopCatalogTags = ${JSON.stringify(tags)};
          export { loadDesktopCatalog } from "./locale-catalog-file.js";
        `,
          resolveDir: path.join(desktopRoot, "src", "main"),
        }),
      );
    },
  };
}
