import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptSourceVersion } from "./prompt-source-version.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "prompt-version-"));
  roots.push(root);
  const write = (name: string, content: string) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { root, write };
}

describe("prompt source version", () => {
  it("discovers added definitions and changes in branches without executing them", () => {
    const { root, write } = fixture();
    const name = "packages/example/src/nested/agent.prompt.ts";
    write(name, 'export const instruction = enabled ? "Do the task." : "Stay silent.";');
    const original = promptSourceVersion(root);
    write(name, 'export const instruction = enabled ? "Do the task." : "Ask for help.";');
    expect(promptSourceVersion(root)).not.toBe(original);
    write(name, 'export const instruction = enabled ? "Do the task." : "Stay silent.";');
    expect(promptSourceVersion(root)).toBe(original);
    const added = "apps/example/src/summary.prompt.ts";
    write(added, 'export const instructions = "Summarize.";');
    expect(promptSourceVersion(root)).not.toBe(original);
    rmSync(path.join(root, added));
    expect(promptSourceVersion(root)).toBe(original);
  });

  it("includes tool descriptions and schemas, and ignores other files", () => {
    const { root, write } = fixture();
    const name = "packages/example/src/example.tool-definition.ts";
    write(name, 'export const tool = { description: "Read.", inputSchema: { type: "object" } };');
    const original = promptSourceVersion(root);
    write("packages/example/src/example.test.ts", 'const input = "private fixture";');
    write(".env", "PRIVATE_VALUE=fake-placeholder");
    write("README.md", "Some documentation.");
    expect(promptSourceVersion(root)).toBe(original);
    write(
      name,
      'export const tool = { description: "Read a file.", inputSchema: { type: "object" } };',
    );
    expect(promptSourceVersion(root)).not.toBe(original);
    write(name, 'export const tool = { description: "Read.", inputSchema: { type: "string" } };');
    expect(promptSourceVersion(root)).not.toBe(original);
  });

  it("is independent of checkout location, directory creation order and line endings", () => {
    const left = fixture();
    const right = fixture();
    const a = "packages/example/src/a.prompt.ts";
    const b = "apps/example/src/b.tool-definition.ts";
    left.write(a, "first\nsecond\n");
    left.write(b, "tool\n");
    right.write(b, "tool\r\n");
    right.write(a, "first\r\nsecond\r\n");
    expect(promptSourceVersion(left.root)).toBe(promptSourceVersion(right.root));
  });

  it("fails when a source checkout has no definitions instead of recording an empty version", () => {
    expect(() => promptSourceVersion(fixture().root)).toThrow("No prompt definitions found");
  });
});
