import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFixtures } from "./fixtures.js";

describe("fixtures/*.json", () => {
  it("match the generated data (run `pnpm fixtures` after changing data.ts)", () => {
    for (const [name, value] of Object.entries(buildFixtures())) {
      const onDisk = JSON.parse(
        readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"),
      );
      expect(onDisk, name).toEqual(JSON.parse(JSON.stringify(value)));
    }
  });
});
