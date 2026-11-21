import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SCHEMA = new URL("../../packages/db/prisma/schema.prisma", import.meta.url);
const LISTS = new URL(
  "../../packages/adapters/src/secrets/secret-holder-columns.json",
  import.meta.url,
);

/** `table.column` for each scalar field whose name contains "cipher", by its database names. */
function cipherColumns(schema) {
  const columns = [];
  for (const [, model, body] of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const table = body.match(/@@map\("(\w+)"\)/)?.[1] ?? model;
    for (const line of body.split("\n")) {
      const field = line.match(/^\s+(\w+)\s+\w/);
      if (!field || !/cipher/i.test(field[1])) continue;
      const column = line.match(/@map\("(\w+)"\)/)?.[1] ?? field[1];
      columns.push(`${table}.${column}`);
    }
  }
  return columns.sort();
}

test("cipherColumns finds mapped and unmapped cipher fields", () => {
  const schema = [
    "model Vault {",
    "  id String @id",
    '  keyCipher String @map("key_cipher")',
    "  sealedCiphertext String?",
    '  @@map("vaults")',
    "}",
  ].join("\n");
  assert.deepEqual(cipherColumns(`${schema}\n`), ["vaults.key_cipher", "vaults.sealedCiphertext"]);
});

test("every cipher column is either checked by the secret backup or never remote", () => {
  const { checked, neverRemote } = JSON.parse(readFileSync(LISTS, "utf8"));
  const listed = [...checked, ...neverRemote].sort();
  const columns = cipherColumns(readFileSync(SCHEMA, "utf8"));
  assert.deepEqual(
    columns,
    listed,
    "A column holding a sealed value must be listed in packages/adapters/src/secrets/secret-holder-columns.json: " +
      'under "checked" if it can hold a remote store entry (secret cleanup looks it up before ' +
      'deleting one), or under "neverRemote" if it never does.',
  );
});
