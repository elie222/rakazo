import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { createComputerPermissionSetup } from "./computer-permissions.js";

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
    expect(deps.permissions.isTrustedAccessibilityClient.mock.calls).toEqual([
      [false],
      [true],
      [false],
    ]);
    expect(deps.permissions.requestScreenCapture).toHaveBeenCalledOnce();
    expect(deps.permissions.requestScreenCapture.mock.invocationCallOrder[0]).toBeLessThan(
      showSetup.mock.invocationCallOrder[0]!,
    );
    expect(deps.openSettings).toHaveBeenCalledOnce();
    expect(deps.restart).toHaveBeenCalledOnce();
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
