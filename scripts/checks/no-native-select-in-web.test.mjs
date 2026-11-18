import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find((candidate) => candidate.name === "no-native-select-in-web");

const fixture = mkdtempSync(path.join(tmpdir(), "native-select-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "apps/web/src/pages/Settings.tsx":
    'import { NativeSelect } from "@rakazo/ui-web";\n<NativeSelect value={value} />\n',
  "packages/ui-web/src/components/ui/picker.tsx": "return <select\n  value={value}>\n<select>\n",
  "apps/web/src/pages/space/Board.tsx": "<OptionSelect value={value} options={options} />\n",
  "apps/web/src/pages/space/Board.test.tsx": "const stub = () => <select />;\n",
  "packages/page-kit/src/kit/controls.tsx": "return <select value={value} />;\n",
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts native selects in the web app and its UI kit, but not tests or other packages", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/web/src/pages/Settings.tsx": [1, 2],
      "packages/ui-web/src/components/ui/picker.tsx": [1, 3],
    },
  );
});

test("a new native select fails with a message naming OptionSelect", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /OptionSelect from @rakazo\/ui-web/);
  assert.match(failure, /apps\/web\/src\/pages\/Settings\.tsx:2/);
});
