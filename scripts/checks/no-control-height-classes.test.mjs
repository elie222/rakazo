import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find(
  (candidate) => candidate.name === "no-control-height-classes",
);

const fixture = mkdtempSync(path.join(tmpdir(), "control-height-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "apps/web/src/pages/Settings.tsx": [
    '<Button size="sm" className="h-8 px-2">Save</Button>',
    "<OptionSelect",
    "  value={value}",
    '  className={cn("w-full", wide && "md:h-9")}',
    "/>",
    'const field = "mt-2 h-12 rounded-xl";',
    "<Input className={field} />",
    '<Button size="icon" className="[&_svg]:size-5" />',
    '<Button className="h-auto min-h-8 whitespace-normal">Long label</Button>',
    '<Input size="lg" className="w-full" />',
    '<Button className="h-auto size-9" />',
    'const pill = cn("rounded-full", wide && "h-10");',
    "<Button className={pill} />",
    `<Button className="h-9 after:content-['x']" />`,
    'const typed: string = "h-10";',
    "<OptionSelect<Unit> value={unit} className={typed} />",
    '<InputGroup className="h-9 rounded-xl" />',
    '<ButtonGroup className="h-9" />',
  ].join("\n"),
  "packages/ui-web/src/components/ui/picker.tsx": '<SelectTrigger className="h-10" />\n',
  "apps/web/src/pages/Settings.test.tsx": '<Button className="h-9" />\n',
  "apps/mobile/app/settings.tsx": '<Button className="h-9" />\n',
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts heights set by className on a control, across lines and through constants", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/web/src/pages/Settings.tsx": [1, 2, 7, 11, 13, 14, 16, 17],
      "packages/ui-web/src/components/ui/picker.tsx": [1],
    },
  );
});

test("a new hand-set height fails with a message naming the size prop", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /size prop/);
  assert.match(failure, /apps\/web\/src\/pages\/Settings\.tsx:2/);
});
