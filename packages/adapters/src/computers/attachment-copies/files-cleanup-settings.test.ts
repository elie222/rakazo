import { describe, expect, it } from "vitest";
import { filesCleanupSettings } from "./files-cleanup-settings.js";

const DAY = 24 * 60 * 60_000;

describe("filesCleanupSettings", () => {
  it("cleans nothing by default, after 31 days, looking daily", () => {
    expect(filesCleanupSettings({})).toEqual({
      attachments: false,
      maxAgeMs: 31 * DAY,
      intervalMs: DAY,
    });
  });

  it("reads the switch and the age", () => {
    expect(
      filesCleanupSettings({
        FILES_CLEANUP_ATTACHMENTS: "true",
        FILES_CLEANUP_MAX_AGE_DAYS: "10",
        FILES_CLEANUP_INTERVAL_HOURS: "6",
      }),
    ).toEqual({ attachments: true, maxAgeMs: 10 * DAY, intervalMs: 6 * 60 * 60_000 });
  });

  it("names the setting it does not understand", () => {
    expect(() => filesCleanupSettings({ FILES_CLEANUP_ATTACHMENTS: "yes" })).toThrow(
      "FILES_CLEANUP_ATTACHMENTS",
    );
    for (const value of ["0", "abc", "-1", "1.5", "36501"]) {
      expect(() => filesCleanupSettings({ FILES_CLEANUP_MAX_AGE_DAYS: value })).toThrow(
        "FILES_CLEANUP_MAX_AGE_DAYS",
      );
      expect(() => filesCleanupSettings({ FILES_CLEANUP_INTERVAL_HOURS: value })).toThrow(
        "FILES_CLEANUP_INTERVAL_HOURS",
      );
    }
  });
});
