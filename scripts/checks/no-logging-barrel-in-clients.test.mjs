import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find(
  (candidate) => candidate.name === "no-logging-barrel-in-clients",
);

const fixture = mkdtempSync(path.join(tmpdir(), "logging-barrel-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "apps/web/src/pages/Boot.tsx": 'import { log } from "@rakazo/logging";\n',
  "apps/mobile/lib/query/query.ts": 'import { log } from "@rakazo/logging";\n',
  "packages/chat-ui/src/markdown.ts": 'import { log } from "@rakazo/logging";\n',
  "packages/ui-web/src/lib/cn.ts": 'import { log } from "@rakazo/logging";\n',
  "packages/chat-ui/src/log.ts": 'export { bestEffort } from "@rakazo/logging/best-effort";\n',
  "packages/adapters/src/tool.ts": 'import { log } from "@rakazo/logging";\n',
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts the logging root in the app and in every client-compiled package", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/web/src/pages/Boot.tsx": [1],
      "apps/mobile/lib/query/query.ts": [1],
      "packages/chat-ui/src/markdown.ts": [1],
      "packages/ui-web/src/lib/cn.ts": [1],
    },
  );
});

test("a root import in a shared client package fails with a message naming the subpath", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /@rakazo\/logging\/best-effort/);
  assert.match(failure, /packages\/chat-ui\/src\/markdown\.ts:1/);
});
