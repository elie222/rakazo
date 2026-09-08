import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKING_AVATAR_DURATIONS_MS } from "@rakazo/core";
import { describe, expect, it } from "vitest";

describe("organic working avatar CSS", () => {
  it("keeps working durations aligned with shared core choreography", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"),
      "utf8",
    );
    const uniqueSeconds = [...new Set(WORKING_AVATAR_DURATIONS_MS.map((ms) => ms / 1000))];
    for (const seconds of uniqueSeconds) {
      const token = Number.isInteger(seconds) ? `${seconds}s` : `${seconds}s`;
      expect(css).toContain(token);
    }
  });
});
