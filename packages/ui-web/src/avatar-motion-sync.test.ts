import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKING_AVATAR_DURATIONS_MS } from "@rakazo/core";
import { describe, expect, it } from "vitest";

/** CSS `data-shape-family` → expected duration seconds (mirrors styles.css). */
const FAMILY_DURATION_SECONDS = [1.8, 1.35, 1.6, 2.4, 2.4, 1.35, 1.1, 1.35, 1.6, 1.35] as const;

function workingDurationSecondsForFamily(css: string, family: number): number | null {
  // Split on rule closers so a wrong duration cannot match a later family's token.
  for (const chunk of css.split("}")) {
    if (!chunk.includes(`data-shape-family="${family}"]`)) continue;
    if (!chunk.includes(".rakazo-organic-avatar-body-working")) continue;
    const match = chunk.match(/animation:\s*[^;]*?\s([\d.]+)s\b/);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

describe("organic working avatar CSS", () => {
  it("keeps each shape-family duration aligned with shared core choreography", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"),
      "utf8",
    );
    expect(WORKING_AVATAR_DURATIONS_MS).toHaveLength(FAMILY_DURATION_SECONDS.length);
    for (let family = 0; family < FAMILY_DURATION_SECONDS.length; family += 1) {
      const seconds = FAMILY_DURATION_SECONDS[family]!;
      const sharedMs = WORKING_AVATAR_DURATIONS_MS[family];
      expect(sharedMs).toBeTypeOf("number");
      expect(sharedMs! / 1000).toBe(seconds);
      expect(workingDurationSecondsForFamily(css, family)).toBe(seconds);
    }
  });
});
