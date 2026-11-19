export const message =
  "Do not parse a stored message's blocks as one array. One sibling entry the current schema rejects (a kind an earlier release wrote, or an entry that is not a block) fails the whole parse and hides every block in the row, which can strand a pending card. Read the row entry by entry with readMessageBlocks, parse only the block you act on, and write an answer back with changeMessageBlocks, all from packages/db/src/threads/message-blocks.ts.";

export const include = ["packages/**/*.ts", "packages/**/*.tsx", "apps/**/*.ts", "apps/**/*.tsx"];

export const exclude = ["**/*.{test,spec}.*", "**/generated/**"];

// A stored row is unknown JSON: parse it one entry at a time, never as a list. Both names are in
// use: `packages/db` imports the schema as `MessageBlockSchema`, while other callers use the
// exported `MessageBlock`, and the boundary keeps `storedMessageBlock` from matching.
export const pattern =
  /\b(?:MessageBlock|MessageBlockSchema)\s*\.array\(\)\s*\.\s*(?:safeParse|parse)\s*\(/g;
