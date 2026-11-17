import { EventEmitter } from "node:events";
import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import {
  createComputerPermissionSetup,
  waitForComputerSetupReturn,
} from "./computer-permissions.js";

function setup(
  overrides: Partial<Omit<Parameters<typeof createComputerPermissionSetup>[0], "permissions">> = {},
) {
  const deps = {
    platform: "darwin" as NodeJS.Platform,
    permissions: {
      isTrustedAccessibilityClient: vi.fn(() => false),
      getMediaAccessStatus: vi.fn(() => "denied"),
      requestScreenCapture: vi.fn(async () => []),
    },
    showSetup: vi.fn(async () => "later" as const),
    openSettings: vi.fn(async () => undefined),
    restart: vi.fn(),
    ...overrides,
  };
  return { deps, prepare: createComputerPermissionSetup(deps) };
}

describe("computer permission setup", () => {
  it.each(["win32", "linux"] as const)(
    "does not request Mac permissions on %s",
    async (platform) => {
      const { deps, prepare } = setup({ platform });
      await prepare();
      expect(deps.permissions.isTrustedAccessibilityClient).not.toHaveBeenCalled();
      expect(deps.permissions.requestScreenCapture).not.toHaveBeenCalled();
      expect(deps.showSetup).not.toHaveBeenCalled();
    },
  );

  it("leaves an already configured Mac alone", async () => {
    const { deps, prepare } = setup();
    deps.permissions.isTrustedAccessibilityClient.mockReturnValue(true);
    deps.permissions.getMediaAccessStatus.mockReturnValue("granted");
    await prepare();
    expect(deps.permissions.isTrustedAccessibilityClient).toHaveBeenCalledExactlyOnceWith(false);
    expect(deps.permissions.requestScreenCapture).not.toHaveBeenCalled();
    expect(deps.showSetup).not.toHaveBeenCalled();
  });

  it("requests both missing permissions before the guide, and can open Settings then restart", async () => {
    const actions = ["settings", "restart"] as const;
    const showSetup = vi.fn(async () => actions[showSetup.mock.calls.length - 1]!);
    const { deps, prepare } = setup({ showSetup });
    await prepare();
    expect(deps.permissions.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(deps.permissions.requestScreenCapture).toHaveBeenCalledOnce();
    expect(deps.permissions.requestScreenCapture.mock.invocationCallOrder[0]).toBeLessThan(
      showSetup.mock.invocationCallOrder[0]!,
    );
    expect(deps.openSettings).toHaveBeenCalledOnce();
    expect(deps.restart).toHaveBeenCalledOnce();
  });

  it("rechecks grants from the initial OS prompt before showing the first guide", async () => {
    const { deps, prepare } = setup();
    deps.permissions.isTrustedAccessibilityClient.mockReturnValue(true);
    deps.permissions.requestScreenCapture.mockImplementation(async () => {
      deps.permissions.getMediaAccessStatus.mockReturnValue("granted");
      return [];
    });
    await prepare();
    expect(deps.showSetup).toHaveBeenCalledExactlyOnceWith(true);
    expect(deps.openSettings).not.toHaveBeenCalled();
  });

  it("waits for a return from Settings, then offers only the remaining restart step", async () => {
    const returned = deferred<void>();
    const showSetup = vi
      .fn(async (_readyForRestart: boolean) => "settings" as "settings" | "later")
      .mockResolvedValueOnce("settings")
      .mockResolvedValue("later");
    const { deps, prepare } = setup({ showSetup, openSettings: () => returned.promise });
    const request = prepare();
    await vi.waitFor(() => expect(showSetup).toHaveBeenCalledExactlyOnceWith(false));
    deps.permissions.isTrustedAccessibilityClient.mockReturnValue(true);
    deps.permissions.getMediaAccessStatus.mockReturnValue("granted");
    returned.resolve();
    await request;
    expect(showSetup.mock.calls).toEqual([[false], [true]]);
  });

  it("does not request a permission that is already granted", async () => {
    const { deps, prepare } = setup();
    deps.permissions.getMediaAccessStatus.mockReturnValue("granted");
    await prepare();
    expect(deps.permissions.requestScreenCapture).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it("offers the guide when the OS refuses the capture request", async () => {
    const { deps, prepare } = setup();
    deps.permissions.requestScreenCapture.mockRejectedValue(new Error("Screen recording denied"));
    await prepare();
    expect(deps.showSetup).toHaveBeenCalledOnce();
  });

  it("does not request permissions for an invalid request", async () => {
    const { deps, prepare } = setup();
    await prepare(() => false);
    expect(deps.permissions.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(deps.showSetup).not.toHaveBeenCalled();
  });

  it.each(["restart", "settings"] as const)(
    "ignores a stale dialog's %s action",
    async (action) => {
      const answer = deferred<typeof action>();
      const showSetup = vi.fn(() => answer.promise);
      const { deps, prepare } = setup({ showSetup });
      let valid = true;
      const request = prepare(() => valid);
      await vi.waitFor(() => expect(showSetup).toHaveBeenCalledOnce());
      valid = false;
      answer.resolve(action);
      await request;
      expect(deps.restart).not.toHaveBeenCalled();
      expect(deps.openSettings).not.toHaveBeenCalled();
    },
  );

  it("starts a fresh guide for a later approval when the original one is cancelled", async () => {
    const answer = deferred<"restart">();
    const showSetup = vi
      .fn()
      .mockImplementationOnce(() => answer.promise)
      .mockResolvedValue("later");
    const { deps, prepare } = setup({ showSetup });
    let firstValid = true;
    const first = prepare(() => firstValid);
    await vi.waitFor(() => expect(showSetup).toHaveBeenCalledOnce());
    firstValid = false;
    const second = prepare(() => true);
    answer.resolve("restart");
    await Promise.all([first, second]);
    expect(showSetup).toHaveBeenCalledTimes(2);
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it("gives a later approval its own guide after the earlier attempt fails", async () => {
    const answer = deferred<"later">();
    const showSetup = vi
      .fn()
      .mockImplementationOnce(() => answer.promise)
      .mockResolvedValue("later");
    const { prepare } = setup({ showSetup });
    const first = prepare();
    await vi.waitFor(() => expect(showSetup).toHaveBeenCalledOnce());
    const second = prepare();
    const failure = new Error("Could not open native dialog");
    const rejected = expect(first).rejects.toBe(failure);
    answer.reject(failure);
    await rejected;
    await second;
    expect(showSetup).toHaveBeenCalledTimes(2);
  });

  it("shares one setup flow across concurrent requests", async () => {
    const answer = deferred<"later">();
    const showSetup = vi.fn(() => answer.promise);
    const { deps, prepare } = setup({ showSetup });
    const first = prepare();
    const second = prepare();
    await vi.waitFor(() => expect(showSetup).toHaveBeenCalledOnce());
    expect(deps.permissions.requestScreenCapture).toHaveBeenCalledOnce();
    answer.resolve("later");
    await Promise.all([first, second]);
  });
});

describe("returning to permission setup", () => {
  it.each(["activate", "browser-window-focus"] as const)(
    "continues on %s and removes both listeners",
    async (event) => {
      const events = new EventEmitter();
      const returned = waitForComputerSetupReturn(events, async () => undefined);
      expect(events.listenerCount("activate")).toBe(1);
      expect(events.listenerCount("browser-window-focus")).toBe(1);
      events.emit(event);
      await returned;
      expect(events.listenerCount("activate")).toBe(0);
      expect(events.listenerCount("browser-window-focus")).toBe(0);
    },
  );
});

describe("opening Settings", () => {
  it.each(["activate", "browser-window-focus"] as const)(
    "remembers %s during the launch",
    async (event) => {
      const events = new EventEmitter();
      const opened = deferred<void>();
      const returned = waitForComputerSetupReturn(events, async () => {
        events.emit(event);
        await opened.promise;
      });
      opened.resolve();
      await returned;
      expect(events.listenerCount("activate")).toBe(0);
      expect(events.listenerCount("browser-window-focus")).toBe(0);
    },
  );

  it.each([false, true])(
    "removes listeners if Settings fails to open, synchronous=%s",
    async (synchronous) => {
      const events = new EventEmitter();
      const failure = new Error("Could not open Settings");
      const returned = waitForComputerSetupReturn(events, () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      });
      await expect(returned).rejects.toBe(failure);
      expect(events.listenerCount("activate")).toBe(0);
      expect(events.listenerCount("browser-window-focus")).toBe(0);
    },
  );

  it("ignores activation before the Settings launch", async () => {
    const events = new EventEmitter();
    events.emit("activate");
    const returned = waitForComputerSetupReturn(events, async () => undefined);
    expect(events.listenerCount("activate")).toBe(1);
    events.emit("browser-window-focus");
    await returned;
  });
});
