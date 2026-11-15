export const message =
  "Remove the eslint-disable comment: this repo lints with Biome, which ignores it. If Biome flags the line, fix the code.";

export const include = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,astro}"];

export const exclude = ["scripts/checks/ratchets/**"];

export const pattern = /eslint-disable/g;
