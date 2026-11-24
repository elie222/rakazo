import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, report, scan, violations } from "./ratchets.mjs";

const rule = (await loadRules()).find((candidate) => candidate.name === "no-silent-catch");

const fixture = mkdtempSync(path.join(tmpdir(), "silent-catch-"));
after(() => rmSync(fixture, { recursive: true }));

const sources = {
  "apps/api/src/run.ts": "void start().catch(() => undefined);\n",
  "apps/web/src/pages/Boot.tsx": "void load().catch(() => undefined);\n",
  "apps/mobile/lib/query/query.ts": "void send().catch(() => null);\n",
  "packages/chat-ui/src/hooks.ts": "void read().catch(() => {});\n",
  "packages/ui-web/src/lib/cn.ts": "void copy().catch(() => undefined);\n",
  "packages/page-kit/src/runtime.tsx": "void boot().catch(() => undefined);\n",
  "apps/web/src/pages/Boot.test.tsx": "void load().catch(() => undefined);\n",
  "apps/mobile/lib/query/send.ts": 'export const sent = bestEffort("send", send);\n',
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts a discarded rejection in server and client code, but not in tests", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/api/src/run.ts": [1],
      "apps/web/src/pages/Boot.tsx": [1],
      "apps/mobile/lib/query/query.ts": [1],
      "packages/chat-ui/src/hooks.ts": [1],
      "packages/ui-web/src/lib/cn.ts": [1],
      "packages/page-kit/src/runtime.tsx": [1],
    },
  );
});

test("a client silent catch fails with a message naming the client subpath", () => {
  const failure = report(rule, violations({}, found));
  assert.match(failure, /@rakazo\/logging\/best-effort in mobile and web code/);
  assert.match(failure, /apps\/mobile\/lib\/query\/query\.ts:1/);
});
