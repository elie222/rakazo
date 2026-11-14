import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

/** Hash authored definitions, including branches that a sample rendering would not exercise. */
export function promptSourceVersion(root: string): string {
  const files = globSync(
    [
      "packages/*/src/**/*.prompt.ts",
      "packages/*/src/**/*.tool-definition.ts",
      "apps/*/src/**/*.prompt.ts",
      "apps/*/src/**/*.tool-definition.ts",
    ],
    { cwd: root },
  )
    .map((file) => file.split(path.sep).join("/"))
    .sort();
  if (files.length === 0) throw new Error("No prompt definitions found");
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(
      JSON.stringify([file, readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n")]),
    );
  }
  return hash.digest("hex");
}
