// @vitest-environment jsdom

import { HeaderBackButton } from "expo-router/react-navigation";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsLayout from "../app/(settings)/_layout";

type HeaderItem = { label: string; onPress: () => void };
type BackButtonProps = {
  accessibilityLabel: string;
  displayMode: string;
  tintColor?: string;
  onPress: () => void;
};
type ScreenOptions = (props: {
  navigation: { getState: () => { routes: { key: string }[] } };
  route: { key: string };
}) => {
  unstable_headerLeftItems?: () => HeaderItem[];
  headerBackVisible?: boolean;
  headerLeft?: (props: { tintColor?: string }) => ReactElement<BackButtonProps>;
};

const { stack, sheet } = vi.hoisted(() => ({
  stack: { screenOptions: undefined as ScreenOptions | undefined },
  sheet: { canGoBack: vi.fn(), goBack: vi.fn(), dispatch: vi.fn() },
}));

vi.mock("expo-router", () => {
  function Stack(props: { screenOptions: ScreenOptions; children?: ReactNode }) {
    stack.screenOptions = props.screenOptions;
    return null;
  }
  Stack.Screen = () => null;
  return { Stack, useNavigation: () => sheet };
});
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../components/glass-title", () => ({
  floatingHeaderOptions: () => ({}),
  glassHeaderOptions: (title: string) => ({ title }),
}));
vi.mock("expo-router/react-navigation", () => ({ HeaderBackButton: () => null }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));

function headerOptions(page: string, pages: string[]) {
  return stack.screenOptions!({
    navigation: { getState: () => ({ routes: pages.map((key) => ({ key })) }) },
    route: { key: page },
  });
}

function headerItems(page: string, pages: string[]) {
  return headerOptions(page, pages).unstable_headerLeftItems?.() ?? [];
}

describe("settings sheet header", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Platform.OS = "ios";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<SettingsLayout />));
    act(() => root.unmount());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes the sheet from its first page back to the screen under it", () => {
    sheet.canGoBack.mockReturnValue(true);
    const [close] = headerItems("account", ["account"]);
    expect(close?.label).toBe("Dismiss");
    close?.onPress();

    expect(sheet.goBack).toHaveBeenCalledTimes(1);
    expect(headerItems("models", ["account", "models"])).toEqual([]);
  });

  it.each(["account", "change-password"])("leaves a cold deep link to %s for Home", (page) => {
    sheet.canGoBack.mockReturnValue(false);
    const [close] = headerItems(page, [page]);
    close?.onPress();

    expect(sheet.goBack).not.toHaveBeenCalled();
    expect(sheet.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "index" } });
  });

  it("shows an Android back arrow from the inbox that dismisses through the parent", () => {
    Platform.OS = "android";
    sheet.canGoBack.mockReturnValue(true);
    const options = headerOptions("account", ["account"]);
    const back = options.headerLeft!({ tintColor: "ink" });

    expect(options.headerBackVisible).toBe(false);
    expect(back.type).toBe(HeaderBackButton);
    expect(back.props).toMatchObject({
      accessibilityLabel: "Back",
      displayMode: "minimal",
      tintColor: "ink",
    });
    back.props.onPress();
    expect(sheet.goBack).toHaveBeenCalledTimes(1);
    expect(sheet.dispatch).not.toHaveBeenCalled();
  });

  it.each(["account", "change-password"])(
    "shows an Android back arrow for a cold link to %s that returns Home",
    (page) => {
      Platform.OS = "android";
      sheet.canGoBack.mockReturnValue(false);
      const back = headerOptions(page, [page]).headerLeft!({});
      expect(back.type).toBe(HeaderBackButton);
      expect(back.props.accessibilityLabel).toBe("Back");
      expect(back.props.displayMode).toBe("minimal");
      back.props.onPress();
      expect(sheet.goBack).not.toHaveBeenCalled();
      expect(sheet.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "index" } });
    },
  );

  it("leaves the nested Android page's native back button unchanged", () => {
    Platform.OS = "android";
    const options = headerOptions("models", ["account", "models"]);
    expect(options.headerLeft).toBeUndefined();
    expect(options.headerBackVisible).toBeUndefined();
    expect(options.unstable_headerLeftItems).toBeUndefined();
    expect(sheet.goBack).not.toHaveBeenCalled();
    expect(sheet.dispatch).not.toHaveBeenCalled();
  });
});
