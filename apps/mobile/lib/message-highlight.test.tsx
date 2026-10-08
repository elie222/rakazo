// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MessageHighlight } from "../components/message-highlight";

const animation = vi.hoisted(() => ({
  setValue: vi.fn(),
  timing: vi.fn(),
  delay: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reducedMotion: false,
}));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => animation.reducedMotion }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({ foreground: "ink" }) }));
vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } },
  Animated: {
    Value: class {
      setValue = animation.setValue;
    },
    View: ({
      style,
      pointerEvents,
    }: {
      style: object[];
      pointerEvents: string;
      children?: ReactNode;
    }) =>
      createElement("div", {
        "data-style": JSON.stringify(style),
        "data-pointer-events": pointerEvents,
      }),
    timing: animation.timing,
    delay: animation.delay,
    sequence: () => ({ start: animation.start, stop: animation.stop }),
  },
}));
it.each([false, true])(
  "keeps a rounded inset tint and respects reduced motion (%s)",
  (reducedMotion) => {
    vi.clearAllMocks();
    animation.reducedMotion = reducedMotion;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<MessageHighlight active />));
      expect(JSON.parse(container.firstElementChild!.getAttribute("data-style")!)).toEqual([
        { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
        { borderRadius: 20, backgroundColor: "ink", opacity: {} },
      ]);
      expect(container.firstElementChild!.getAttribute("data-pointer-events")).toBe("none");
      expect(animation.setValue).toHaveBeenLastCalledWith(0.08);
      if (reducedMotion) expect(animation.start).not.toHaveBeenCalled();
      else {
        expect(animation.delay).toHaveBeenCalledWith(600);
        expect(animation.timing).toHaveBeenCalledWith(expect.anything(), {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        });
        expect(animation.start).toHaveBeenCalledOnce();
      }
      act(() => root.render(<MessageHighlight active={false} />));
      expect(animation.setValue).toHaveBeenLastCalledWith(0);
      if (!reducedMotion) expect(animation.stop).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
