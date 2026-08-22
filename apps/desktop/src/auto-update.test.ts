import { describe, expect, it } from "vitest";
import {
  classifyUpdaterFailure,
  initialUpdateState,
  MIN_CHECK_INTERVAL_MS,
  reduceUpdateState,
  shouldCheck,
  type UpdaterEvent,
  updaterSupport,
} from "./auto-update.js";

const NOW = "2026-08-22T12:00:00.000Z";
const packaged = { packaged: true, version: "0.1.0" };

function apply(events: UpdaterEvent[], env = packaged) {
  return events.reduce(
    (state, event) => reduceUpdateState(state, event, NOW),
    initialUpdateState(env),
  );
}

describe("updaterSupport", () => {
  it("only runs in an installed build that has not opted out", () => {
    expect(updaterSupport(packaged).supported).toBe(true);
    expect(updaterSupport({ packaged: false, version: "0.1.0" }).supported).toBe(false);
    expect(updaterSupport({ ...packaged, disabled: true }).supported).toBe(false);
  });

  it("starts unsupported builds in a state that explains itself", () => {
    const state = initialUpdateState({ packaged: false, version: "0.1.0" });
    expect(state).toMatchObject({ phase: "unsupported", currentVersion: "0.1.0" });
    expect(state.message).toContain("installed build");
  });
});

describe("classifyUpdaterFailure", () => {
  it("treats a repository with no releases as an absent feed, not a fault", () => {
    for (const message of [
      "HttpError: 404 Not Found",
      "Cannot find latest.yml in the latest release",
      "No published versions on GitHub",
    ]) {
      expect(classifyUpdaterFailure(new Error(message)).kind, message).toBe("no-releases");
    }
  });

  it("stays silent when the machine is simply offline", () => {
    for (const message of ["getaddrinfo ENOTFOUND github.com", "net::ERR_INTERNET_DISCONNECTED"]) {
      expect(classifyUpdaterFailure(new Error(message))).toEqual({
        kind: "offline",
        message: null,
      });
    }
  });

  it("always surfaces a signing problem with the original detail", () => {
    const failure = classifyUpdaterFailure(
      new Error("Code signature at URL did not pass validation"),
    );
    expect(failure.kind).toBe("signature");
    expect(failure.message).toContain("did not pass validation");
  });

  it("keeps anything else as a plain message", () => {
    expect(classifyUpdaterFailure(new Error("disk full"))).toEqual({
      kind: "other",
      message: "disk full",
    });
    expect(classifyUpdaterFailure("")).toMatchObject({ kind: "other" });
  });
});

describe("reduceUpdateState", () => {
  it("walks from a check to a downloaded release", () => {
    const state = apply([
      { type: "check-start" },
      { type: "available", version: "0.2.0" },
      { type: "download-start" },
      { type: "progress", percent: 42.6 },
      { type: "downloaded", version: "0.2.0" },
    ]);
    expect(state).toMatchObject({
      phase: "ready",
      availableVersion: "0.2.0",
      percent: 100,
    });
    expect(state.message).toContain("Restart Rakazo");
  });

  it("clamps progress to a percentage", () => {
    expect(apply([{ type: "progress", percent: -5 }]).percent).toBe(0);
    expect(apply([{ type: "progress", percent: 250 }]).percent).toBe(100);
  });

  it("clears an offer when a later check finds nothing", () => {
    const state = apply([
      { type: "available", version: "0.2.0" },
      { type: "check-start" },
      { type: "not-available" },
    ]);
    expect(state).toMatchObject({ phase: "idle", availableVersion: null, checkedAt: NOW });
  });

  it("goes quiet on a missing feed instead of nagging every launch", () => {
    const state = apply([
      { type: "check-start" },
      { type: "failed", error: new Error("HttpError: 404"), userInitiated: false },
    ]);
    expect(state.phase).toBe("unsupported");
    expect(state.message).toContain("No desktop releases");
    // An unsupported install stops reacting, so later launches cannot re-raise the same notice.
    expect(reduceUpdateState(state, { type: "check-start" }, NOW)).toBe(state);
    expect(shouldCheck(state, 10_000_000, 0)).toBe(false);
  });

  it("says nothing about being offline unless the user asked", () => {
    const offline = new Error("getaddrinfo ENOTFOUND github.com");
    expect(apply([{ type: "failed", error: offline, userInitiated: false }]).message).toBeNull();
    expect(apply([{ type: "failed", error: offline, userInitiated: true }]).message).toContain(
      "Could not reach",
    );
  });

  it("reports a real failure either way", () => {
    const state = apply([{ type: "failed", error: new Error("disk full"), userInitiated: false }]);
    expect(state).toMatchObject({ phase: "error", message: "disk full" });
  });
});

describe("shouldCheck", () => {
  it("allows the first check and then rate-limits", () => {
    const idle = initialUpdateState(packaged);
    expect(shouldCheck(idle, 1_000, 0)).toBe(true);
    expect(shouldCheck(idle, 1_000, 900)).toBe(false);
    expect(shouldCheck(idle, MIN_CHECK_INTERVAL_MS + 1_000, 1_000)).toBe(true);
  });

  it("never starts a second check on top of work already running", () => {
    const busy = apply([{ type: "check-start" }]);
    expect(shouldCheck(busy, 10_000_000, 0)).toBe(false);
    const downloading = apply([{ type: "download-start" }]);
    expect(shouldCheck(downloading, 10_000_000, 0)).toBe(false);
  });
});
