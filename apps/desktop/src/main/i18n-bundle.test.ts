import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import {
  desktopLocaleCatalogFiles,
  emitDesktopLocaleCatalogs,
} from "../../scripts/locale-catalogs.js";

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

    const probe = `
      import { strict as assert } from "node:assert";
      import { rmSync } from "node:fs";
      import * as i18n from ${JSON.stringify(pathToFileURL(bundle).href)};

      const label = "Check for Updates…";
      assert.equal(i18n.startDesktopLocale("es-MX", "en"), "es");
      assert.equal(i18n.t(label), "Buscar actualizaciones…");

      // Remove the Hebrew catalog after startup. It must still be unread at this point.
      rmSync(new URL("./locales/he.json", ${JSON.stringify(pathToFileURL(bundle).href)}));
      let savedLocale;
      const reportLocale = i18n.createLocaleHandler(async (locale) => {
        savedLocale = locale;
      }, () => {});
      await reportLocale(null, "he");
      assert.equal(savedLocale, "he");
      assert.equal(i18n.desktopLocale(), "en");
      assert.equal(i18n.desktopDirection(), "ltr");
      assert.equal(i18n.t(label), label);
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(output).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
