import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("lists eval cases without importing a generated database client or runtime adapters", () => {
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@rakazo/db' || specifier === '@rakazo/adapters') {
          throw new Error('Runtime imported before database generation');
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      path.resolve(import.meta.dirname, "../cli/evals.ts"),
      "--list",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(output).toContain("workspace-memory-isolation:");
  expect(output.trim().split("\n")).toHaveLength(15);
});
