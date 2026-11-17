import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const folder of [".", "apps/web"]) {
  test(`translation discovery excludes tests from ${folder}`, async () => {
    const previous = process.cwd();
    process.chdir(path.join(root, folder));
    try {
      const catalogs = await getCatalogs(
        getConfig({ configPath: path.join(root, "lingui.config.ts") }),
      );
      const sources = catalogs
        .flatMap((catalog) => catalog.sourcePaths)
        .map((file) => file.replaceAll("\\", "/"));
      assert(sources.some((file) => file.endsWith("/apps/mobile/lib/i18n/i18n.ts")));
      assert(sources.some((file) => file.includes("/apps/web/src/")));
      assert.equal(
        sources.filter((file) => /\.test\.|\/node_modules\/|\/locales\//.test(file)).length,
        0,
        "Only production source files belong in translation discovery",
      );
    } finally {
      process.chdir(previous);
    }
  });
}
