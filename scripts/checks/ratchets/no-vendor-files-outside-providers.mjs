import { pattern } from "./no-vendor-names-outside-adapters.mjs";

export const message =
  "A file named after a vendor is that vendor's code: move it into packages/adapters/src/providers/<family>/<id>/, and keep what several providers share outside providers/ under a neutral name.";

const ADAPTERS = "packages/adapters/src/";

export const include = [`${ADAPTERS}**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`];

export const exclude = [`${ADAPTERS}providers/**`];

const vendorName = new RegExp(pattern.source, pattern.flags.replace("g", ""));

/** The rule reads the path, not the text: vendor code outside providers/ is a misplaced file. */
export function count(_text, file) {
  return vendorName.test(file.slice(ADAPTERS.length)) ? [{ line: 1, text: file }] : [];
}
