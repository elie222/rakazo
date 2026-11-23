// Core's source is grouped into topic folders; its root holds only the barrel, so a new file has to
// pick the topic it belongs to.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORE_SRC = path.join(root, "packages/core/src");

test("core keeps no loose source files beside its barrel", () => {
  const loose = readdirSync(CORE_SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "index.ts")
    .map((entry) => entry.name);
  assert.deepEqual(
    loose,
    [],
    `Move these into the topic folder they belong to under packages/core/src/: ${loose.join(", ")}`,
  );
});
