import { readFileSync } from "node:fs";

export const message =
  'Do not cast a value read from a JSON column to its shape. Read it with readJsonColumn(schema, value, { table, column, id }, "reject" | { fallback }) from @rakazo/db, which checks it and makes the reader choose what a row in another shape means; message blocks have storedMessageBlocks(message), readMessageBlocks(message) where a missing block decides something, and changeMessageBlocks(message, change) to write one back. A property that only shares a column\'s name is a false positive: rename the local or narrow it with a type guard.';

// The server code that holds database rows. Clients and packages/core read wire shapes instead.
export const include = ["{apps/{api,worker},packages/{adapters,auth,db,memory}}/src/**/*.{ts,mts}"];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*test-support*",
  "**/e2e/**",
  "packages/db/src/generated/**",
];

// Every Json field of the Prisma schema, so a new column is checked from the migration that adds it.
function jsonColumns() {
  const schema = readFileSync(
    new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const names = new Set([...schema.matchAll(/^\s+(\w+)\s+Json\b/gm)].map((match) => match[1]));
  if (names.size === 0) throw new Error("Read no Json fields from the Prisma schema");
  return [...names];
}

// A cast straight after the property (or its `?? default`). Writes cast the other way, to
// `never`, `const` or Prisma's input type, and a bare `as unknown` asserts nothing.
const CAST = new RegExp(
  String.raw`\.(?:${jsonColumns().join("|")})\b(?:\s*\?\?\s*(?:\[\]|\{\}))?\)?\s+as\s+(?!const\b|never\b|Prisma\.Input|unknown\b(?!\s+as\b))([^\n]*)`,
  "g",
);
// A probe names keys it then checks one by one (`as { url?: unknown } | null`): it asserts no shape.
const PROBE = /^\{(?:\s*\w+\?: unknown[;,]?)+\s*\}/;

export function count(text) {
  const hits = [];
  for (const match of text.matchAll(CAST)) {
    if (PROBE.test(match[1])) continue;
    const line = text.slice(0, match.index).split("\n").length;
    hits.push({ line, text: match[0].trim() });
  }
  return hits;
}
