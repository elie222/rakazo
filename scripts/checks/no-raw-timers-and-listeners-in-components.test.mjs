import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRules, scan } from "./ratchets.mjs";

const rule = (await loadRules()).find(
  (candidate) => candidate.name === "no-raw-timers-and-listeners-in-components",
);

const fixture = mkdtempSync(path.join(tmpdir(), "raw-timers-"));
after(() => rmSync(fixture, { recursive: true }));

const effects = 'import { useEffect } from "react";\n';
const sources = {
  "apps/web/src/pages/panel.tsx": `useEffect(() => {
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
const timer = window.setTimeout(close, 100);
`,
  "apps/web/src/pages/shell/use-clock.ts": `${effects}const timer = setInterval(tick, 1000);\n`,
  "apps/mobile/components/card.tsx": "const timer = setTimeout (() => setFailed(true), 50);\n",
  "apps/web/src/components/frame.tsx":
    'const GUARD = `\ndocument.addEventListener("click", block);\nsetTimeout(ready, 0);\n`;\nsetTimeout(close, 10);\n',
  "apps/web/src/pages/leak.tsx": `useEffect(() => {\n  window.addEventListener("resize", sync);\n}, []);\n`,
  "apps/mobile/lib/use-foreground.ts": `${effects}const sub = AppState.addEventListener("change", onChange);\nsignal.addEventListener("abort", stop);\n`,
  "apps/mobile/lib/use-pulse.ts": `${effects}globalThis.setTimeout(pulse, 10);\n`,
  "apps/mobile/lib/api/api.ts": "const timer = setTimeout(() => controller.abort(), 5000);\n",
  "apps/web/src/lib/calls/call-session.ts":
    'import { useSyncExternalStore } from "react";\nhangUp = setTimeout(endCall, 1000);\n',
  "apps/web/server/preview-middleware.ts": "socket.setTimeout(1000, done);\n",
  "apps/web/src/pages/converted.tsx":
    'useTimeout(close, 100);\nuseEventListener(window, "resize", sync);\n',
  "apps/web/src/lib/use-event-listener.ts": `${effects}target.removeEventListener(type, onEvent);\n`,
  "apps/web/src/pages/panel.test.tsx": "setTimeout(done, 10);\n",
  "packages/chat-ui/src/hooks.ts": `${effects}const timer = setTimeout(() => fire(), ms);\n`,
};
for (const [file, text] of Object.entries(sources)) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  writeFileSync(path.join(fixture, file), text);
}
const found = scan([rule], Object.keys(sources), fixture).get(rule.name);

test("counts raw timers and added listeners, including one never removed", () => {
  assert.deepEqual(
    Object.fromEntries([...found].map(([file, hits]) => [file, hits.map((hit) => hit.line)])),
    {
      "apps/web/src/pages/panel.tsx": [2, 5],
      "apps/web/src/pages/leak.tsx": [2],
      "apps/web/src/components/frame.tsx": [5],
      "apps/web/src/pages/shell/use-clock.ts": [2],
      "apps/mobile/components/card.tsx": [1],
      "apps/mobile/lib/use-pulse.ts": [2],
    },
  );
});

test("leaves helpers without effects, method calls, converted code, the hooks and tests alone", () => {
  for (const file of [
    "apps/mobile/lib/api/api.ts",
    "apps/mobile/lib/use-foreground.ts",
    "apps/web/src/lib/calls/call-session.ts",
    "apps/web/server/preview-middleware.ts",
    "apps/web/src/pages/converted.tsx",
    "apps/web/src/lib/use-event-listener.ts",
    "apps/web/src/pages/panel.test.tsx",
    "packages/chat-ui/src/hooks.ts",
  ]) {
    assert.equal(found.has(file), false, file);
  }
});

test("names the hooks to use", () => {
  for (const hook of ["useTimeout", "useNow", "useEventListener"]) {
    assert.match(rule.message, new RegExp(hook));
  }
});
