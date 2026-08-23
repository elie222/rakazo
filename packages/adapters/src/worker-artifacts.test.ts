import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("worker artifact wiring", () => {
  it("constructs the run executor with an artifact store", () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/worker/src/index.ts"),
      "utf8",
    );
    expect(source).toContain("LocalArtifactStore");
    expect(source).toContain("artifacts,");
  });
});
