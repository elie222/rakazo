import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promptSourceVersion } from "@rakazo/core/node/prompt-source-version";
import { describe, expect, it } from "vitest";
import { promptVersion, promptVersionOf, promptVersionParts } from "./prompt-version.js";

const PROMPT_VERSION = promptVersion();

describe("prompt version", () => {
  it("is a short hash that is the same on every call", () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersionOf(promptVersionParts())).toBe(PROMPT_VERSION);
    expect(promptVersion()).toBe(PROMPT_VERSION);
    expect(promptVersionOf(promptVersionParts())).toBe(promptVersionOf(promptVersionParts()));
  });

  it("changes when a template or the history format changes", () => {
    const parts = promptVersionParts();
    expect(promptVersionOf({ ...parts, computerUse: `${parts.computerUse} ` })).not.toBe(
      PROMPT_VERSION,
    );
    expect(promptVersionOf({ ...parts, sources: "changed-definition" })).not.toBe(PROMPT_VERSION);
    const [first, ...rest] = parts.tools;
    const schemaChanged = [first![0], first![1], { ...(first![2] as object), extra: true }];
    expect(promptVersionOf({ ...parts, tools: [schemaChanged, ...rest] })).not.toBe(PROMPT_VERSION);
    expect(promptVersionOf({ ...parts, historyFormat: parts.historyFormat + 1 })).not.toBe(
      PROMPT_VERSION,
    );
    expect(
      promptVersionOf({
        ...parts,
        context: { ...parts.context, recentToolResultsToKeep: 99 },
      }),
    ).not.toBe(PROMPT_VERSION);
  });

  it("renders the full system prompt templates", () => {
    const text = JSON.stringify(promptVersionParts());
    expect(text).toContain("Prefer tools over claiming you already did the work.");
    expect(text).toContain("reply_target");
  });
});

// Use the production bundler, then execute only its artifact outside the source tree.
it("embeds the development fingerprint in production bundles", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "prompt-bundle-")));
  const outfile = path.join(directory, "prompt-version.mjs");
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { build } from "esbuild";
      import { serverBuildOptions } from "./scripts/build-server.mjs";
      await build({
        ...serverBuildOptions(${JSON.stringify(path.join(root, "packages/adapters/src/prompt-version.ts"))}, ${JSON.stringify(outfile)}),
        sourcemap: false,
      });
    `,
      ],
      { cwd: root, stdio: "pipe" },
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { promptVersionParts, promptVersion } from ${JSON.stringify(pathToFileURL(outfile).href)};
      console.log(JSON.stringify({ sources: promptVersionParts().sources, version: promptVersion() }));
    `,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    const result = JSON.parse(output.trim());
    expect(result.sources).toBe(promptSourceVersion(root));
    expect(result.version).toBe(PROMPT_VERSION);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
