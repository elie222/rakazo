import { describe, expect, it } from "vitest";
import type { HomeVersion } from "./home-versions.js";
import { keptHomeRevisions } from "./home-versions.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date("2026-11-19T15:00:00Z");

/** A save every `everyMs` from `from` up to now, named by when it happened. */
function saves(from: Date, everyMs: number): HomeVersion[] {
  const versions: HomeVersion[] = [];
  for (let at = from.getTime(); at <= now.getTime(); at += everyMs)
    versions.push({ revision: new Date(at).toISOString(), savedAt: new Date(at) });
  return versions;
}

describe("keptHomeRevisions", () => {
  it("keeps the newest saves and each recent day's first and last", () => {
    const versions = saves(new Date("2026-11-10T00:10:00Z"), 20 * 60_000);
    const current = versions.at(-1)!.revision;

    const kept = [...keptHomeRevisions(versions, current, now)].sort();

    expect(kept).toEqual(
      [
        // The newest three, the current one among them.
        "2026-11-19T14:30:00.000Z",
        "2026-11-19T14:50:00.000Z",
        "2026-11-19T14:10:00.000Z",
        // Today's first save.
        "2026-11-19T00:10:00.000Z",
        // The first and last save of each of the six days before.
        ...[13, 14, 15, 16, 17, 18].flatMap((day) => [
          `2026-11-${day}T00:10:00.000Z`,
          `2026-11-${day}T23:50:00.000Z`,
        ]),
      ].sort(),
    );
  });

  it("still keeps a copy from before a damaged home was saved over and over", () => {
    // Saved every twenty minutes, and damaged five hours ago.
    const versions = saves(new Date(now.getTime() - 3 * DAY), 20 * 60_000);
    const damagedAt = now.getTime() - 5 * HOUR;
    const kept = [...keptHomeRevisions(versions, versions.at(-1)!.revision, now)];
    expect(kept.some((revision) => new Date(revision).getTime() < damagedAt)).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(3 + 2 * 7);
  });

  it("always keeps the current revision, even an old one a restore made current", () => {
    const versions = saves(new Date(now.getTime() - 30 * DAY), DAY);
    const restored = versions[0]!.revision;
    expect(keptHomeRevisions(versions, restored, now).has(restored)).toBe(true);
  });

  it("forgets days past the window", () => {
    const old = { revision: "old", savedAt: new Date(now.getTime() - 10 * DAY) };
    const recent = saves(new Date(now.getTime() - 2 * HOUR), HOUR);
    expect(keptHomeRevisions([old, ...recent], recent.at(-1)!.revision, now).has("old")).toBe(
      false,
    );
  });
});
