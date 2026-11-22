import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractFromFileWithBabel, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

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
      assert(
        sources.some((file) =>
          file.endsWith("/packages/adapters/src/models/model-provider-registry.ts"),
        ),
      );
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

test("subscription descriptors retain existing translation keys", async () => {
  const filename = path.join(root, "packages/adapters/src/models/model-provider-registry.ts");
  const workflow = readFileSync(
    path.join(root, ".github/workflows/translation-catalogs.yml"),
    "utf8",
  );
  assert(workflow.includes("- packages/adapters/src/models/model-provider-registry.ts"));
  const messages = [];
  await extractFromFileWithBabel(
    filename,
    readFileSync(filename, "utf8"),
    (message) => messages.push(message),
    { linguiConfig: getConfig({ configPath: path.join(root, "lingui.config.ts") }) },
    { plugins: ["typescript"] },
  );
  assert(
    messages.some(
      (message) => message.id === "XrwIDk" && message.message === "ChatGPT subscription",
    ),
  );
  assert(
    messages.some(
      (message) => message.id === "oCbawp" && message.message === "Claude subscription",
    ),
  );
  for (const { id, message, context } of messages) {
    const po = await formatter().serialize(
      { [id]: { message, context, translation: message } },
      { locale: "de", sourceLocale: "en", filename: "messages.po", existing: undefined },
    );
    assert(
      !po.includes("js-lingui-explicit-id"),
      "Subscription descriptor IDs must match Lingui's generated message IDs",
    );
  }
});
