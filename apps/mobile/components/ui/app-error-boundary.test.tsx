// @vitest-environment jsdom

import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportMobileError } from "../../lib/platform/monitoring";
import { completeMobileStartup } from "../../lib/platform/startup";
import { AppErrorBoundary } from "./app-error-boundary";

vi.mock("../../lib/platform/monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("../../lib/platform/startup", () => ({ completeMobileStartup: vi.fn() }));
vi.mock("expo-splash-screen", () => ({ hideAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({
    background: "background",
    foreground: "foreground",
    primary: "primary",
    primaryForeground: "primary-foreground",
  }),
}));
vi.mock("react-native", () => ({
  Pressable: (props: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={props.onPress}>
      {props.children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ accessibilityRole, children }: { accessibilityRole?: string; children?: ReactNode }) =>
    accessibilityRole === "header" ? <h1>{children}</h1> : <span>{children}</span>,
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
    vi.clearAllMocks();
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

  it("explains a failure without exposing details and renders the children again after retry", async () => {
    await act(async () =>
      root.render(
        <AppErrorBoundary>
          <Child />
        </AppErrorBoundary>,
      ),
    );

    expect(container.querySelector("h1")?.textContent).toBe("Could not load");
    expect(container.textContent).not.toContain("render failed");
    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(expect.any(Error), "react.render");
    expect(SplashScreen.hideAsync).toHaveBeenCalledOnce();
    expect(completeMobileStartup).toHaveBeenCalledOnce();

    shouldThrow = false;
    act(() => retry?.click());

    expect(container.textContent).toBe("Recovered content");
    expect(reportMobileError).toHaveBeenCalledOnce();
    expect(SplashScreen.hideAsync).toHaveBeenCalledOnce();
    expect(completeMobileStartup).toHaveBeenCalledOnce();
  });
});
