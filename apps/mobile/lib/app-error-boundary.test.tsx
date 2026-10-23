// @vitest-environment jsdom

import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../components/app-error-boundary";

vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("expo-splash-screen", () => ({ hideAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/appearance", () => ({
  mobileTokens: () => ({
    background: "background",
    foreground: "foreground",
    primary: "primary",
    primaryForeground: "primary-foreground",
  }),
}));
vi.mock("../lib/i18n", () => ({ t: (text: string) => text }));
vi.mock("react-native", () => ({
  Pressable: (props: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={props.onPress}>
      {props.children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

let shouldThrow = true;

function Child() {
  if (shouldThrow) throw new Error("render failed");
  return <div>Recovered content</div>;
}

describe("AppErrorBoundary", () => {
  let root: Root;
  let container: HTMLDivElement;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows one retry action and renders the children again after retry", () => {
    act(() =>
      root.render(
        <AppErrorBoundary>
          <Child />
        </AppErrorBoundary>,
      ),
    );

    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    expect(SplashScreen.hideAsync).toHaveBeenCalledOnce();

    shouldThrow = false;
    act(() => retry?.click());

    expect(container.textContent).toBe("Recovered content");
  });
});
