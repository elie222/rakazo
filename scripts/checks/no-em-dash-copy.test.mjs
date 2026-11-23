import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find((candidate) => candidate.name === "no-em-dash-copy");

const fixture = mkdtempSync(path.join(tmpdir(), "em-dash-copy-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "apps/web/src/pages/Files.tsx": [
    "<Trans>Preview only — download it to view it.</Trans>",
    "<Trans>",
    "  Saved &mdash; you can close this.",
    "</Trans>",
    'const empty = value ?? "—";',
    "<Trans>—</Trans>",
    "// Fallback — shown while loading.",
    '<Plural value={n} one="# file — ready" other="# files" />',
  ].join("\n"),
  "apps/mobile/components/notice.tsx": [
    "const label = t`Couldn't refresh — showing saved messages.`;",
    "const missing = t`—`;",
    "const note = msg`Done \\u2014 sent.`;",
    'const answer = t({ message: "Answer — now", context: "call" });',
    'const empty = t({ message: "—" });',
  ].join("\n"),
  "apps/desktop/src/main/setup/setup.ts": [
    'throw new Error(t("Server is down — try again"));',
    'const blank = t("—");',
  ].join("\n"),
  "apps/desktop/src/main/locales/ru.ts": '"Save": "Сохранить — сейчас",\n',
  "apps/web/src/pages/Files.test.tsx": "<Trans>Preview only — download it.</Trans>\n",
  "packages/adapters/src/tool.ts": "const error = t`Invalid — try again`;\n",
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts em dashes inside translatable UI strings, but not placeholders, comments or plain strings", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/web/src/pages/Files.tsx": [1, 2, 8],
      "apps/mobile/components/notice.tsx": [1, 3, 4],
      "apps/desktop/src/main/setup/setup.ts": [1],
    },
  );
});

test("a new em dash in copy fails with a message naming the alternatives", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /period, comma or colon/);
  assert.match(failure, /apps\/web\/src\/pages\/Files\.tsx:1/);
});
