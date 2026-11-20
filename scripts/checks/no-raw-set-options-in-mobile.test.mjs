import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find(
  (candidate) => candidate.name === "no-raw-set-options-in-mobile",
);

const fixture = mkdtempSync(path.join(tmpdir(), "raw-set-options-"));
after(() => rmSync(fixture, { recursive: true }));

const effect = `useLayoutEffect(() => {
  navigation.setOptions({ title });
}, [navigation, title]);
`;
const sources = {
  "apps/mobile/app/(settings)/note.tsx": effect,
  "apps/mobile/components/thread/header.tsx": `${effect}navigation.setOptions(\n  options,\n);\n`,
  "apps/mobile/lib/inbox/use-inbox-header.ts":
    "const { setOptions } = navigation;\nsetOptions({ title });\n",
  "apps/mobile/app/optional.tsx":
    "navigation?.setOptions?.(options);\nnavigation.setOptions (options);\n",
  "apps/mobile/app/converted.tsx": "useScreenHeader({ title });\nresetOptions();\n",
  "apps/mobile/lib/navigation/screen-header.tsx": "navigation.setOptions(options);\n",
  "apps/mobile/lib/note-screen.test.tsx":
    "const navigation = { setOptions: () => state.setOptions() };\n",
  "apps/web/src/routes/note.tsx": effect,
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts every setOptions call in the mobile app's screens, components and helpers", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/mobile/app/(settings)/note.tsx": [2],
      "apps/mobile/app/optional.tsx": [1, 2],
      "apps/mobile/components/thread/header.tsx": [2, 4],
      "apps/mobile/lib/inbox/use-inbox-header.ts": [2],
    },
  );
});

test("leaves the hook's own module, tests, converted screens and other apps alone", () => {
  for (const file of [
    "apps/mobile/app/converted.tsx",
    "apps/mobile/lib/navigation/screen-header.tsx",
    "apps/mobile/lib/note-screen.test.tsx",
    "apps/web/src/routes/note.tsx",
  ]) {
    assert.equal(found.has(file), false, file);
  }
});

test("a new call fails with a message that names the hook, and a frozen one passes", () => {
  const frozen = {
    "apps/mobile/components/thread/header.tsx": 2,
    "apps/mobile/lib/inbox/use-inbox-header.ts": 1,
  };
  const failure = report(rule, violations(frozen, found));
  assert.match(failure, /useScreenHeader\(\{ title, action \}\)/);
  assert.match(failure, /apps\/mobile\/lib\/navigation\/screen-header\.tsx/);
  assert.match(
    failure,
    /apps\/mobile\/app\/\(settings\)\/note\.tsx:2 {2}navigation\.setOptions\(\{ title \}\);/,
  );
  assert.doesNotMatch(failure, /thread\/header\.tsx/);

  const grown = violations({ ...frozen, "apps/mobile/components/thread/header.tsx": 1 }, found);
  assert.deepEqual(
    grown.map(({ file }) => file),
    [
      "apps/mobile/app/(settings)/note.tsx",
      "apps/mobile/components/thread/header.tsx",
      "apps/mobile/app/optional.tsx",
    ],
  );
});
