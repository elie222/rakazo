import { describe, expect, it, vi } from "vitest";
import {
  classifyUpdaterFailure,
  DesktopUpdateController,
  type ElectronAutoUpdater,
  initialUpdateState,
  MIN_CHECK_INTERVAL_MS,
  reduceUpdateState,
  shouldCheck,
  type UpdaterEvent,
  updaterSupport,
} from "./auto-update.js";

const NOW = "2026-08-22T12:00:00.000Z";
const packaged = { packaged: true, version: "0.1.0" };
const clock = { now: () => 1_000, iso: () => NOW };

function apply(events: UpdaterEvent[], env = packaged) {
  return events.reduce(
    (state, event) => reduceUpdateState(state, event, NOW),
    initialUpdateState(env),
  );
}

function fakeUpdater(overrides: Partial<ElectronAutoUpdater> = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const updater: ElectronAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    allowPrerelease: true,
    disableWebInstaller: false,
    on: vi.fn((event, listener) => {
      listeners.set(event, listener);
      return updater;
    }),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    ...overrides,
  };
  return {
    updater,
    emit(event: string, payload?: unknown) {
      listeners.get(event)?.(payload);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("surfaces signing failures without leaking the updater's raw URL or path", () => {
    const failure = classifyUpdaterFailure(
      new Error("Code signature at https://private.invalid/update.zip did not pass validation"),
    );
    expect(failure.kind).toBe("signature");
    expect(failure.message).toContain("could not be verified");
    expect(failure.message).not.toContain("private.invalid");
  });

  it("keeps unclassified updater detail out of the renderer bridge", () => {
    const failure = classifyUpdaterFailure(new Error("disk full at /Users/example/private"));
    expect(failure).toEqual({
      kind: "other",
      message: "The update could not be completed. Try again later.",
    });
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

  it("clears an offer when a completed check finds nothing", () => {
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
      { type: "failed", error: new Error("HttpError: 404 Not Found"), userInitiated: false },
    ]);
    expect(state.phase).toBe("unsupported");
    expect(state.message).toContain("No desktop releases");
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

  it("reports other failures with a safe generic message", () => {
    const state = apply([{ type: "failed", error: new Error("disk full"), userInitiated: false }]);
    expect(state).toMatchObject({
      phase: "error",
      message: "The update could not be completed. Try again later.",
    });
  });
});

describe("shouldCheck", () => {
  it("allows the first check and then rate-limits", () => {
    const idle = initialUpdateState(packaged);
    expect(shouldCheck(idle, 1_000, 0)).toBe(true);
    expect(shouldCheck(idle, 1_000, 900)).toBe(false);
    expect(shouldCheck(idle, MIN_CHECK_INTERVAL_MS + 1_000, 1_000)).toBe(true);
  });

  it("does not replace work, an available update, or a downloaded update", () => {
    for (const state of [
      apply([{ type: "check-start" }]),
      apply([{ type: "available", version: "0.2.0" }]),
      apply([{ type: "download-start" }]),
      apply([{ type: "downloaded", version: "0.2.0" }]),
    ]) {
      expect(shouldCheck(state, 10_000_000, 0)).toBe(false);
    }
  });
});

describe("DesktopUpdateController", () => {
  it("locks the updater to stable, upgrade-only, signed installer behavior", async () => {
    const fake = fakeUpdater();
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, clock);

    await controller.check(false);

    expect(fake.updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
    });
  });

  it("serializes concurrent checks across the asynchronous updater load", async () => {
    const check = deferred();
    const fake = fakeUpdater({ checkForUpdates: vi.fn(() => check.promise) });
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, clock);

    const first = controller.check(false);
    const second = controller.check(true);
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(second).toBe(first);
    check.resolve();
    await first;
  });

  it("automatically downloads one verified stable update and tracks progress", async () => {
    let fake: ReturnType<typeof fakeUpdater>;
    fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        fake.emit("checking-for-update");
        fake.emit("update-available", { version: "0.2.0" });
      }),
      downloadUpdate: vi.fn(async () => {
        fake.emit("download-progress", { percent: 48.8 });
        fake.emit("update-downloaded", { version: "0.2.0" });
      }),
    });
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, clock);

    await controller.check(false);
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(controller.state().phase).toBe("ready"));
    expect(controller.state()).toMatchObject({
      availableVersion: "0.2.0",
      percent: 100,
    });
  });

  it("joins manual downloads to the automatic download already in flight", async () => {
    const download = deferred();
    let fake: ReturnType<typeof fakeUpdater>;
    fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        fake.emit("checking-for-update");
        fake.emit("update-available", { version: "0.2.0" });
      }),
      downloadUpdate: vi.fn(() => download.promise),
    });
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, clock);

    await controller.check(false);
    const first = controller.download();
    const second = controller.download();
    expect(second).toBe(first);
    expect(fake.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    download.resolve();
    await first;
  });

  it("does not treat later background failures as user-requested", async () => {
    let now = 1_000;
    let fake: ReturnType<typeof fakeUpdater>;
    fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        fake.emit("checking-for-update");
        if (fake.updater.checkForUpdates.mock.calls.length === 1) {
          fake.emit("update-not-available");
        } else {
          fake.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));
        }
      }),
    });
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, {
      now: () => now,
      iso: () => NOW,
    });

    await controller.check(true);
    now += MIN_CHECK_INTERVAL_MS;
    await controller.check(false);

    expect(controller.state()).toMatchObject({ phase: "idle", message: null });
  });

  it("runs installation at most once", async () => {
    let fake: ReturnType<typeof fakeUpdater>;
    fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        fake.emit("checking-for-update");
        fake.emit("update-available", { version: "0.2.0" });
      }),
      downloadUpdate: vi.fn(async () => {
        fake.emit("update-downloaded", { version: "0.2.0" });
      }),
    });
    const controller = new DesktopUpdateController(packaged, async () => fake.updater, clock);
    await controller.check(false);
    await vi.waitFor(() => expect(controller.state().phase).toBe("ready"));

    await Promise.all([controller.install(), controller.install()]);
    expect(fake.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
