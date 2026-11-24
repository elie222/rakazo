import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The order is not cosmetic: row-level security must wrap content encryption so its findUnique
// rewrite still passes through the sealing step, and text is cleaned before either of them reads
// an argument. Nothing enforced the comment that says so, so a reorder would have shipped quietly.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientSource = readFileSync(
  path.join(repoRoot, "packages/db/src/database/client.ts"),
  "utf8",
);

const EXPECTED = ["withTextSanitization", "withRowLevelSecurity", "withContentEncryption"];

function compositionStatement() {
  const start = clientSource.indexOf("const prisma = ");
  assert.notEqual(start, -1, "client.ts must compose the Prisma extensions into `const prisma`");
  const end = clientSource.indexOf(");", start);
  assert.notEqual(end, -1, "the composition statement must end with `);`");
  return clientSource.slice(start, end + 2);
}

test("the security extensions wrap each other in the order the comment requires", () => {
  const statement = compositionStatement();
  const applied = [...statement.matchAll(/with[A-Z]\w*\(/g)].map((match) => match[0].slice(0, -1));
  assert.deepEqual(
    applied,
    EXPECTED,
    `The extensions must be applied outermost first: ${EXPECTED.join(" > ")}. Row-level security wraps content encryption so its findUnique rewrite still runs through it, and text is sanitised before either sees the argument.`,
  );
});

test("each security extension is applied exactly once", () => {
  for (const name of EXPECTED) {
    const uses = clientSource.match(new RegExp(`\\b${name}\\(`, "g")) ?? [];
    assert.equal(
      uses.length,
      1,
      `${name} must be applied in exactly one place, so no second client is built without it`,
    );
  }
});
