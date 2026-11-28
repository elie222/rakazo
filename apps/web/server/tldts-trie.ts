import type { Plugin } from "vite";

const TRIE_FILE = "/tldts/dist/es6/src/data/trie.js";
const LABEL_ASSIGNMENT = 'export const labelText = "';

/**
 * Rolldown inlines a const string into each `.charCodeAt` call and also keeps
 * the binding. The public-suffix trie is one 68 KB literal, so that puts three
 * copies in the web startup chunk. `String(literal)` is the same string and
 * stays a single binding.
 *
 * The scan reads one double-quoted literal and the semicolon that ends it. A
 * later statement on that line stays as it is. Any other shape is left as shipped.
 */
function keepSuffixTrieShared(code: string): string | undefined {
  const at = code.indexOf(LABEL_ASSIGNMENT);
  if (at < 0) return;
  const close = endOfStringLiteral(code, at + LABEL_ASSIGNMENT.length);
  if (close == null) return;
  let semicolon = close;
  while (code[semicolon] === " " || code[semicolon] === "\t") semicolon += 1;
  if (code[semicolon] !== ";") return;
  const literal = code.slice(at + "export const labelText = ".length, close);
  return `${code.slice(0, at)}export const labelText = String(${literal})${code.slice(semicolon)}`;
}

/** Index just after the closing quote. An unfinished or multi-line literal does not match. */
function endOfStringLiteral(code: string, body: number): number | undefined {
  for (let i = body; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "\\") {
      if (i + 1 >= code.length) return;
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") return;
    if (ch === '"') return i + 1;
  }
  return;
}

function isVendoredTrie(id: string): boolean {
  const file = id.split("?", 1)[0];
  if (!file) return false;
  const normalized = file.replaceAll("\\", "/");
  return normalized.split("/").includes("node_modules") && normalized.endsWith(TRIE_FILE);
}

export function dedupeTldtsTrie(): Plugin {
  return {
    name: "dedupe-tldts-trie",
    enforce: "pre",
    transform(code, id) {
      if (!isVendoredTrie(id)) return;
      const next = keepSuffixTrieShared(code);
      if (!next) return;
      // The trie is generated vendor data. An empty map marks this transform as
      // accounted for, so the build does not treat every other map as broken.
      return { code: next, map: { mappings: "" } };
    },
  };
}
