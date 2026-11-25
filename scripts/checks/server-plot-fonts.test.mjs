import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

for (const dockerfile of [
  "infra/compose/Dockerfile",
  "infra/compose/Dockerfile.topology",
  "infra/railway/Dockerfile",
]) {
  test(`${dockerfile} installs fonts in its server runtime`, () => {
    const source = readFileSync(new URL(`../../${dockerfile}`, import.meta.url), "utf8");
    const runtime = source.split(/^FROM\s/m).at(-1);
    const installCommands = runtime
      .replace(/\\\r?\n/g, " ")
      .match(/\bapt-get install\b[^&;\r\n]*/g);
    for (const pkg of ["fontconfig", "fonts-dejavu-core"]) {
      assert.ok(
        installCommands?.some((command) => command.split(/\s+/).includes(pkg)),
        pkg,
      );
    }
  });
}
