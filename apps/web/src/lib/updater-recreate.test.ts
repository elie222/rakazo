import { describe, expect, it } from "vitest";
import {
  confirmUpdaterRecreate,
  isLikelyUpdaterRecreateDisconnect,
  type RecreateLastRun,
  recreateWaitTimeoutError,
} from "./updater-recreate.js";

function run(
  partial: Partial<RecreateLastRun> & Pick<RecreateLastRun, "ok" | "fromTag" | "toTag">,
): RecreateLastRun {
  return {
    finishedAt: "2026-08-27T21:00:00.000Z",
    error: null,
    restartAdvice: "",
    ...partial,
  };
}

describe("isLikelyUpdaterRecreateDisconnect", () => {
  it("recognizes common browser and Node transport failures after API recreate", () => {
    expect(isLikelyUpdaterRecreateDisconnect(new Error("Failed to fetch"))).toBe(true);
    expect(
      isLikelyUpdaterRecreateDisconnect(new Error("NetworkError when attempting to fetch")),
    ).toBe(true);
    expect(isLikelyUpdaterRecreateDisconnect(new Error("socket hang up"))).toBe(true);
    expect(isLikelyUpdaterRecreateDisconnect(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("does not treat ordinary updater errors as recreate disconnects", () => {
    expect(
      isLikelyUpdaterRecreateDisconnect(new Error("The updater sidecar is not configured.")),
    ).toBe(false);
    expect(isLikelyUpdaterRecreateDisconnect("failed to fetch")).toBe(false);
    expect(isLikelyUpdaterRecreateDisconnect(null)).toBe(false);
  });
});

describe("confirmUpdaterRecreate", () => {
  it("requires an idle sidecar, matching lastRun, and a changed image tag", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: false,
        supported: true,
        installKind: "sidecar",
        lastRun: run({ ok: true, fromTag: "sha-aaa", toTag: "sha-bbb" }),
      }),
    ).toEqual({ confirmed: true, reason: "changed" });
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: true,
        supported: true,
        installKind: "sidecar",
        lastRun: run({ ok: true, fromTag: "sha-aaa", toTag: "sha-bbb" }),
      }),
    ).toEqual({ confirmed: false, reason: "running" });
  });

  it("does not treat a compose fallback with a changed configured tag as success", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: false,
        supported: false,
        installKind: "compose",
        lastRun: run({ ok: true, fromTag: "sha-aaa", toTag: "sha-bbb" }),
      }),
    ).toEqual({ confirmed: false, reason: "waiting" });
  });

  it("confirms a tag move when lastRun moved from the live before-tag", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-bbb",
        afterImageTag: "sha-aaa",
        running: false,
        supported: true,
        installKind: "sidecar",
        lastRun: run({ ok: true, fromTag: "sha-bbb", toTag: "sha-aaa" }),
      }),
    ).toEqual({ confirmed: true, reason: "changed" });
  });

  it("rejects a stale env pin when recreate failed even if the tag appears to change", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-bbb",
        running: false,
        supported: true,
        installKind: "sidecar",
        lastRun: run({
          ok: false,
          fromTag: "sha-aaa",
          toTag: "sha-bbb",
          error: "Recreate the stack failed.",
          restartAdvice:
            "Recreate the stack failed. The updater restored the previously running sha-aaa image, but could not restore the environment pin.",
        }),
      }),
    ).toEqual({ confirmed: false, reason: "failed" });
  });

  it("waits until a finished lastRun is available", () => {
    expect(
      confirmUpdaterRecreate({
        beforeImageTag: "sha-aaa",
        afterImageTag: "sha-aaa",
        running: false,
        supported: true,
        installKind: "sidecar",
        lastRun: null,
      }),
    ).toEqual({ confirmed: false, reason: "waiting" });
  });
});

describe("recreateWaitTimeoutError", () => {
  it("reports sidecar unavailable when only fallback status was seen", () => {
    expect(recreateWaitTimeoutError({ sawApi: true, sawSidecar: false }).message).toBe(
      "The updater sidecar was unavailable after reconnect.",
    );
  });

  it("reports still running when a live sidecar status was seen", () => {
    expect(recreateWaitTimeoutError({ sawApi: true, sawSidecar: true }).message).toBe(
      "The updater was still running when the wait timed out.",
    );
  });

  it("keeps the last transport error when the API never came back", () => {
    expect(
      recreateWaitTimeoutError({
        sawApi: false,
        sawSidecar: false,
        lastError: new Error("Failed to fetch"),
      }).message,
    ).toBe("Failed to fetch");
  });
});
