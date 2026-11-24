// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LoadEarlierButton } from "./thread-list-controls";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({ mutedForeground: "#777" }),
}));
vi.mock("../bots/activity-mark", () => ({ ActivityMark: () => null }));
vi.mock("./scroll-to-bottom-button", () => ({ ScrollToBottomButton: () => null }));
vi.mock("react-native", () => ({
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <span role="progressbar" aria-label={accessibilityLabel} />
  ),
  Pressable: ({
    accessibilityRole,
    children,
    disabled,
    onPress,
  }: {
    accessibilityRole?: string;
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" role={accessibilityRole} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

it.each([false, true])("keeps button semantics and behavior with loading=%s", async (loading) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onPress = vi.fn();

  try {
    await act(async () => root.render(<LoadEarlierButton loading={loading} onPress={onPress} />));
    const button = host.querySelector("button");
    expect(button?.getAttribute("role")).toBe("button");
    expect(button?.textContent).toBe("Load earlier messages");
    expect(button?.disabled).toBe(loading);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label") ?? null).toBe(
      loading ? "Loading…" : null,
    );

    await act(async () => button?.click());
    expect(onPress).toHaveBeenCalledTimes(loading ? 0 : 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
