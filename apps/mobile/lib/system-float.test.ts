import { describe, expect, it, vi } from "vitest";
import type { FloatingBubbleModule, SystemFloatWindowModule } from "./system-float";
import {
  hideSystemFloat,
  hideSystemFloatWindow,
  requestSystemFloatPermission,
  setFloatingBubbleModule,
  setSystemFloatWindowModule,
  showSystemFloat,
  showSystemFloatWindow,
  systemFloatHasPermission,
  systemFloatWindowIsShowing,
  systemFloatWindowSupported,
  updateSystemFloatWindowUrl,
} from "./system-float";

vi.mock("react-native-android-floating-bubble", () => {
  throw new Error("no native module in tests");
});

function fakeBubble(overrides: Partial<FloatingBubbleModule> = {}) {
  const show = vi.fn();
  const hide = vi.fn();
  const requestOverlayPermission = vi.fn();
  const bubble: FloatingBubbleModule = {
    isSupported: () => true,
    hasOverlayPermission: () => true,
    requestOverlayPermission,
    show,
    hide,
    ...overrides,
  };
  return { bubble, show, hide, requestOverlayPermission };
}

describe("system float", () => {
  it("shows the bubble when supported and permitted", async () => {
    const { bubble, show } = fakeBubble();
    setFloatingBubbleModule(bubble);
    try {
      await expect(systemFloatHasPermission()).resolves.toBe(true);
      await expect(showSystemFloat()).resolves.toBe("shown");
      expect(show).toHaveBeenCalled();
    } finally {
      setFloatingBubbleModule(null);
    }
  });

  it("reports no-permission without showing the bubble", async () => {
    const { bubble, show } = fakeBubble({ hasOverlayPermission: () => false });
    setFloatingBubbleModule(bubble);
    try {
      await expect(systemFloatHasPermission()).resolves.toBe(false);
      await expect(showSystemFloat()).resolves.toBe("no-permission");
      expect(show).not.toHaveBeenCalled();
    } finally {
      setFloatingBubbleModule(null);
    }
  });

  it("reports unsupported on a device that cannot float", async () => {
    const { bubble, show } = fakeBubble({ isSupported: () => false });
    setFloatingBubbleModule(bubble);
    try {
      await expect(showSystemFloat()).resolves.toBe("unsupported");
      expect(show).not.toHaveBeenCalled();
    } finally {
      setFloatingBubbleModule(null);
    }
  });

  it("reports unsupported when the native module is missing", async () => {
    setFloatingBubbleModule(null);
    await expect(systemFloatHasPermission()).resolves.toBe(false);
    await expect(showSystemFloat()).resolves.toBe("unsupported");
  });

  it("asks the system for the overlay permission", async () => {
    const { bubble, requestOverlayPermission } = fakeBubble({
      hasOverlayPermission: () => false,
    });
    setFloatingBubbleModule(bubble);
    try {
      await requestSystemFloatPermission();
      expect(requestOverlayPermission).toHaveBeenCalled();
    } finally {
      setFloatingBubbleModule(null);
    }
  });

  it("hides the bubble", async () => {
    const { bubble, hide } = fakeBubble();
    setFloatingBubbleModule(bubble);
    try {
      await hideSystemFloat();
      expect(hide).toHaveBeenCalled();
    } finally {
      setFloatingBubbleModule(null);
    }
  });

  it("treats a failing native call as unsupported", async () => {
    const { bubble } = fakeBubble({
      hasOverlayPermission: () => {
        throw new Error("native gone");
      },
    });
    setFloatingBubbleModule(bubble);
    try {
      await expect(showSystemFloat()).resolves.toBe("unsupported");
    } finally {
      setFloatingBubbleModule(null);
    }
  });
});

function fakeWindow(
  options: {
    permitted?: boolean;
    supported?: boolean;
    showResult?: boolean;
    showing?: boolean;
  } = {},
) {
  const show = vi.fn(async () => options.showResult ?? true);
  const updateUrl = vi.fn(async () => undefined);
  const hide = vi.fn(async () => undefined);
  const isShowing = vi.fn(async () => options.showing ?? false);
  const windowModule: SystemFloatWindowModule = {
    isSupported: async () => options.supported ?? true,
    hasOverlayPermission: async () => options.permitted ?? true,
    requestOverlayPermission: () => undefined,
    show,
    updateUrl,
    hide,
    isShowing,
  };
  return { windowModule, show, updateUrl, hide, isShowing };
}

describe("system float window", () => {
  it("shows the live screen when supported and permitted", async () => {
    const { windowModule, show } = fakeWindow();
    setSystemFloatWindowModule(windowModule);
    try {
      await expect(systemFloatWindowSupported()).resolves.toBe(true);
      await expect(
        showSystemFloatWindow("https://screen.example.test/embed", "Computer screen", "en"),
      ).resolves.toBe("shown");
      expect(show).toHaveBeenCalledWith(
        "https://screen.example.test/embed",
        "Computer screen",
        "en",
      );
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("reports no-permission without showing the window", async () => {
    const { windowModule, show } = fakeWindow({ permitted: false });
    setSystemFloatWindowModule(windowModule);
    try {
      await expect(
        showSystemFloatWindow("https://screen.example.test/embed", "Computer screen", "en"),
      ).resolves.toBe("no-permission");
      expect(show).not.toHaveBeenCalled();
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("reports unsupported when the window module is missing", async () => {
    setSystemFloatWindowModule(null);
    await expect(systemFloatWindowSupported()).resolves.toBe(false);
    await expect(
      showSystemFloatWindow("https://screen.example.test/embed", "Computer screen", "en"),
    ).resolves.toBe("unsupported");
  });

  it("reports unsupported when showing fails", async () => {
    const { windowModule, show } = fakeWindow({ showResult: false });
    setSystemFloatWindowModule(windowModule);
    try {
      await expect(
        showSystemFloatWindow("https://screen.example.test/embed", "Computer screen", "en"),
      ).resolves.toBe("unsupported");
      expect(show).toHaveBeenCalled();
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("re-points a running window at a new screen URL", async () => {
    const { windowModule, updateUrl } = fakeWindow();
    setSystemFloatWindowModule(windowModule);
    try {
      await updateSystemFloatWindowUrl("https://screen.example.test/embed-2");
      expect(updateUrl).toHaveBeenCalledWith("https://screen.example.test/embed-2");
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("hides the window", async () => {
    const { windowModule, hide } = fakeWindow();
    setSystemFloatWindowModule(windowModule);
    try {
      await hideSystemFloatWindow();
      expect(hide).toHaveBeenCalled();
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("reports the window as showing while it is up", async () => {
    const { windowModule, isShowing } = fakeWindow({ showing: true });
    setSystemFloatWindowModule(windowModule);
    try {
      await expect(systemFloatWindowIsShowing()).resolves.toBe(true);
      expect(isShowing).toHaveBeenCalled();
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("reports the window as gone once it is closed from outside", async () => {
    const { windowModule } = fakeWindow({ showing: false });
    setSystemFloatWindowModule(windowModule);
    try {
      await expect(systemFloatWindowIsShowing()).resolves.toBe(false);
    } finally {
      setSystemFloatWindowModule(null);
    }
  });

  it("reports the window as gone when the module is missing", async () => {
    setSystemFloatWindowModule(null);
    await expect(systemFloatWindowIsShowing()).resolves.toBe(false);
  });
});
