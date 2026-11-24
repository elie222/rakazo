import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("createDb wraps the Prisma client in the required security extension order", () => {
  const source = readFileSync(
    new URL("../../packages/db/src/database/client.ts", import.meta.url),
    "utf8",
  );

  const composition =
    /^\s*const prisma\s*=\s*withTextSanitization\s*\(\s*withRowLevelSecurity\s*\(\s*withContentEncryption\s*\(\s*client\s*,/m;

  assert.ok(
    composition.test(source),
    "Nest withContentEncryption inside withRowLevelSecurity so rewritten reads still decrypt content. Keep withTextSanitization outermost to clean the final write arguments before Postgres.",
  );
});
