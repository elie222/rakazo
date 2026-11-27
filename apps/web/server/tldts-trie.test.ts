import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { dedupeTldtsTrie } from "./tldts-trie.js";

const require = createRequire(
  path.resolve(import.meta.dirname, "../../../packages/core/package.json"),
);
const tldtsRoot = path.dirname(require.resolve("tldts/package.json"));
const tldtsEntry = path.join(tldtsRoot, "dist/es6/index.js");
const labelText = readFileSync(path.join(tldtsRoot, "dist/es6/src/data/trie.js"), "utf8").match(
  /export const labelText = "([^"]*)"/,
)?.[1];

function suffixTrieCopies(code: string): number {
  if (!labelText) throw new Error("tldts trie is missing labelText");
  const probe = labelText.slice(0, 80);
  if (labelText.indexOf(probe) !== 0 || labelText.indexOf(probe, 1) !== -1) {
    throw new Error("suffix trie probe is not unique");
  }
  let copies = 0;
  let at = code.indexOf(probe);
  while (at !== -1) {
    copies += 1;
    at = code.indexOf(probe, at + probe.length);
  }
  return copies;
}

async function bundleTldts(
  dedupe: boolean,
): Promise<{ code: string; outfile: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "tldts-trie-"));
  const outfile = path.join(root, "dist/bundle.js");
  const entry = path.join(root, "entry.js");
  await writeFile(
    entry,
    `import { getDomain, parse } from ${JSON.stringify(tldtsEntry)};
export function run(host, options) {
  return { domain: getDomain(host, options), parsedDomain: parse(host, options).domain };
}
`,
  );
  await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: dedupe ? [dedupeTldtsTrie()] : [],
    build: {
      // Library mode keeps `run` exported. An app build drops it, so the trie check
      // would only see the module's side effects.
      lib: { entry, formats: ["es"], fileName: () => "bundle.js" },
      outDir: path.join(root, "dist"),
      emptyOutDir: true,
      minify: true,
      sourcemap: false,
      rolldownOptions: { external: [] },
    },
  });
  return { code: await readFile(outfile, "utf8"), outfile, root };
}

function transformTrie(code: string, id: string): string | undefined {
  const hook = dedupeTldtsTrie().transform;
  if (typeof hook !== "function") throw new Error("dedupeTldtsTrie transform is not a function");
  // The hook's `this` is Vite's plugin context. This call only reads `code` and `id`.
  const call = hook as (code: string, id: string) => { code?: unknown } | null | undefined;
  const result = call(code, id);
  if (result == null) return;
  if (typeof result.code !== "string") throw new Error("expected string code");
  return result.code;
}

async function expectModuleSource(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "tldts-syntax-"));
  const file = path.join(root, "mod.mjs");
  try {
    await writeFile(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    await rm(root, { recursive: true });
  }
}

describe("tldts suffix trie literal", () => {
  it("wraps one literal and leaves the next statement on the same line", async () => {
    const output = transformTrie(
      'export const labelText = "alpha"; export const metadata = "beta";',
      "C:\\repo\\node_modules\\tldts\\dist\\es6\\src\\data\\trie.js",
    );
    expect(output).toBe(
      'export const labelText = String("alpha"); export const metadata = "beta";',
    );
    await expectModuleSource(output ?? "");
  });

  it("keeps escaped quotes and backslashes inside that one literal", async () => {
    const output = transformTrie(
      'export const labelText = "al\\"pha\\\\b";\n',
      "/repo/node_modules/tldts/dist/es6/src/data/trie.js?v=1",
    );
    expect(output).toBe('export const labelText = String("al\\"pha\\\\b");\n');
    await expectModuleSource(output ?? "");
  });

  it("leaves a trie lookalike outside node_modules unchanged", () => {
    const input = 'export const labelText = "alpha";\n';
    expect(transformTrie(input, "/tmp/tldts/dist/es6/src/data/trie.js")).toBeUndefined();
  });
});

describe("tldts suffix trie", () => {
  it("stays one copy in the client bundle and still splits private suffixes", async () => {
    const bundled = await bundleTldts(true);
    try {
      expect(suffixTrieCopies(bundled.code)).toBe(1);
      const mod = (await import(pathToFileURL(bundled.outfile).href)) as {
        run: (
          host: string,
          options: { allowPrivateDomains: boolean },
        ) => { domain: string | null; parsedDomain: string | null };
      };
      const options = { allowPrivateDomains: true };
      expect(mod.run("https://docs.example.co.uk/a", options)).toEqual({
        domain: "example.co.uk",
        parsedDomain: "example.co.uk",
      });
      expect(mod.run("https://alice.github.io/a", options).domain).toBe("alice.github.io");
      expect(mod.run("https://attacker.github.io/", options).domain).toBe("attacker.github.io");
    } finally {
      await rm(bundled.root, { recursive: true });
    }
  });

  it("is copied at every charCodeAt call when the trie stays a const string", async () => {
    const bundled = await bundleTldts(false);
    try {
      expect(suffixTrieCopies(bundled.code)).toBe(3);
    } finally {
      await rm(bundled.root, { recursive: true });
    }
  });
});
