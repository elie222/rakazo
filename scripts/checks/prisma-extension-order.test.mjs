import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("createDb wraps the Prisma client in the required security extension order", () => {
  const source = readFileSync(
    new URL("../../packages/db/src/database/client.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /^\s*const prisma\s*=\s*withTextSanitization\s*\(\s*withRowLevelSecurity\s*\(\s*withContentEncryption\s*\(\s*client\s*,/m,
    "Nest withContentEncryption inside withRowLevelSecurity so rewritten reads still decrypt content. Wrap both with withTextSanitization so write arguments are cleaned first.",
  );
});
