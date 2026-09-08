import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKING_AVATAR_DURATIONS_MS } from "@rakazo/core";
import { describe, expect, it } from "vitest";

/** CSS `data-shape-family` → expected duration seconds (mirrors styles.css). */
const FAMILY_DURATION_SECONDS: Record<number, number> = {
  0: 1.8,
  1: 1.35,
  2: 1.6,
  3: 2.4,
  4: 2.4,
  5: 1.35,
  6: 1.1,
  7: 1.35,
  8: 1.6,
  9: 1.35,
};

describe("organic working avatar CSS", () => {
  it("keeps each shape-family duration aligned with shared core choreography", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"),
      "utf8",
    );
    for (const [family, seconds] of Object.entries(FAMILY_DURATION_SECONDS)) {
      const index = Number(family);
      expect(WORKING_AVATAR_DURATIONS_MS[index] / 1000).toBe(seconds);
      const token = `${seconds}s`;
      expect(css).toContain(`data-shape-family="${family}"] .rakazo-organic-avatar-body-working`);
      // Duration appears on the rule for this family (shared rules cover 2/8, 3/4, 5/9).
      const familyBlock = css.match(
        new RegExp(`data-shape-family="${family}"[\\s\\S]*?animation:[^;]*\\s(${seconds}s)\\s`),
      );
      expect(familyBlock?.[1]).toBe(token);
    }
  });
});
