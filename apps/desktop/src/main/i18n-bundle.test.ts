import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import {
  desktopLocaleCatalogFiles,
  emitDesktopLocaleCatalogs,
} from "../../scripts/locale-catalogs.js";
import type * as I18n from "./i18n.js";

it("loads packaged translations on demand and falls back when a catalog is missing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rakazo-i18n-"));
  try {
    const localeDirectory = path.join(directory, "locales");
    const tags = await emitDesktopLocaleCatalogs(localeDirectory);
    expect((await readdir(localeDirectory)).sort()).toEqual(
      tags.map((tag) => `${tag}.json`).sort(),
    );

    const bundle = path.join(directory, "i18n.mjs");
    await build({
      entryPoints: [path.join(import.meta.dirname, "i18n.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [desktopLocaleCatalogFiles(tags)],
    });

    const i18n: typeof I18n = await import(/* @vite-ignore */ pathToFileURL(bundle).href);
    const label = "Check for Updates…";
    expect(i18n.startDesktopLocale("es-MX", "en")).toBe("es");
    expect(i18n.t(label)).toBe("Buscar actualizaciones…");

    // Removing the catalog after startup makes an eager loader fail this check.
    await rm(path.join(localeDirectory, "he.json"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const save = vi.fn<(locale: string) => Promise<void>>(async () => {});
      const reportLocale = i18n.createLocaleHandler(save, () => {});
      await reportLocale(null, "he");
      expect(save).toHaveBeenCalledExactlyOnceWith("he");
      expect(i18n.desktopLocale()).toBe("en");
      expect(i18n.desktopDirection()).toBe("ltr");
      expect(i18n.t(label)).toBe(label);
    } finally {
      warn.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
