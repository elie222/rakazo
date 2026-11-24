// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PressableProps } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { imageArtifactPreview } from "../../lib/artifacts/artifact-open";
import { InlineImageAttachment } from "./inline-image-attachment";

const recordPressable = vi.hoisted(() => vi.fn<(props: PressableProps) => void>());

vi.mock("react-native", () => ({
  Pressable: (props: { children?: ReactNode }) => {
    recordPressable(props);
    return createElement("div", null, props.children);
  },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement("span", { "aria-label": accessibilityLabel }),
  Image: () => createElement("span", { "data-preview": "" }),
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({ muted: "token-muted", mutedForeground: "token-muted-foreground" }),
}));
vi.mock("../../lib/artifacts/artifact-open", () => ({ imageArtifactPreview: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  recordPressable.mockClear();
  vi.mocked(imageArtifactPreview).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["failed", "ready"] as const)(
  "names the %s image control without losing message actions",
  async (outcome) => {
    const preview = deferred<Awaited<ReturnType<typeof imageArtifactPreview>>>();
    vi.mocked(imageArtifactPreview).mockReturnValue(preview.promise);
    const name = "agenda-photo.png";
    const onOpen = vi.fn();
    const actions = {
      onLongPress: vi.fn(),
      accessibilityActions: [{ name: "copy", label: "Copy" }],
      onAccessibilityAction: vi.fn(),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <InlineImageAttachment
            threadTarget={{ botId: "bot-1" }}
            artifactId="image-1"
            name={name}
            mimeType="image/png"
            onOpen={onOpen}
            pressableProps={actions}
            labelColor="token-foreground"
          />,
        ),
      );

      const loading = recordPressable.mock.lastCall?.[0];
      expect(loading).toMatchObject(actions);
      expect(loading?.accessibilityRole).toBeUndefined();
      expect(loading?.accessibilityLabel).toBeUndefined();
      expect(loading?.onPress).toBeUndefined();
      expect(container.querySelector('[aria-label="Loading image…"]')).not.toBeNull();

      await act(async () => {
        if (outcome === "failed") preview.reject(new Error("Preview unavailable"));
        else preview.resolve({ uri: "file:///mock-preview.png", size: { width: 50, height: 40 } });
      });

      const open = recordPressable.mock.lastCall?.[0];
      expect(open).toMatchObject({
        ...actions,
        accessibilityRole: outcome === "failed" ? "button" : "imagebutton",
        accessibilityLabel: `Open image ${name}`,
        onPress: onOpen,
      });
      expect(container.querySelector('[aria-label="Loading image…"]')).toBeNull();
      if (outcome === "failed") expect(container.textContent).toContain("Tap to open");
      else expect(container.querySelector("[data-preview]")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
