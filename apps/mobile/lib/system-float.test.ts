import { describe, expect, it, vi } from "vitest";
import type { FloatingBubbleModule } from "./system-float";
import {
  hideSystemFloat,
  requestSystemFloatPermission,
  setFloatingBubbleModule,
  showSystemFloat,
  systemFloatHasPermission,
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
