import { flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({
  isEnabled: true,
  createdAt: new Date("2026-10-22T09:30:15Z") as Date | null,
  checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: vi.fn(async () => ({ isNew: true })),
  reloadAsync: vi.fn(async () => {}),
}));
const getInstallReferrerAsync = vi.hoisted(() => vi.fn<() => Promise<string>>());
const rn = vi.hoisted(() => {
  const listeners: Array<(state: string) => void> = [];
  return {
    listeners,
    Alert: { alert: vi.fn() },
    AppState: {
      currentState: "active",
      addEventListener: vi.fn((_type: string, listener: (state: string) => void) => {
        listeners.push(listener);
        return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
      }),
    },
    Linking: { openURL: vi.fn(async () => true) },
    Platform: { OS: "ios" },
  };
});

vi.mock("expo-application", () => ({ getInstallReferrerAsync }));
vi.mock("expo-updates", () => updates);
vi.mock("react-native", () => rn);
vi.mock("./api", () => ({ configureClientBuild: vi.fn() }));

import { ANDROID_APK_URL, ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import {
  clientBuildHeaders,
  FOREGROUND_UPDATE_CHECK_MS,
  mobileClientBuild,
  noteClientUpdateRequired,
  watchForegroundUpdates,
} from "./client-update";

afterEach(() => {
  rn.Platform.OS = "ios";
  updates.checkForUpdateAsync.mockReset().mockResolvedValue({ isAvailable: false });
  updates.isEnabled = true;
  updates.createdAt = new Date("2026-10-22T09:30:15Z");
  vi.clearAllMocks();
});

function pressUpdate() {
  const buttons = rn.Alert.alert.mock.calls.at(-1)?.[2] as Array<{ onPress: () => void }>;
  buttons[0]?.onPress();
}

describe("mobile client build", () => {
  it("names the running bundle by when its update was created", () => {
    expect(mobileClientBuild()).toBe("20261022093015");
    expect(clientBuildHeaders()).toEqual({ "x-rakazo-client-build": "mobile/20261022093015" });
  });

  it("names no build where expo-updates is off", () => {
    updates.isEnabled = false;
    expect(clientBuildHeaders()).toEqual({});
    updates.isEnabled = true;
    updates.createdAt = null;
    expect(mobileClientBuild()).toBeNull();
  });
});

describe("update required", () => {
  it("shows one alert, then applies an available update and reloads", async () => {
    rn.Platform.OS = "android";
    updates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: true });
    noteClientUpdateRequired();
    noteClientUpdateRequired();
    expect(rn.Alert.alert).toHaveBeenCalledOnce();
    expect(rn.Alert.alert.mock.calls[0]?.[0]).toBe("Update required");
    expect(rn.Alert.alert.mock.calls[0]?.[3]).toEqual({ cancelable: false });
    pressUpdate();
    await flush();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(getInstallReferrerAsync).not.toHaveBeenCalled();
    expect(rn.Linking.openURL).not.toHaveBeenCalled();
  });

  it("opens Google Play after an Android install with a Play referrer", async () => {
    rn.Platform.OS = "android";
    getInstallReferrerAsync.mockResolvedValueOnce("utm_source=google-play&utm_medium=organic");
    noteClientUpdateRequired();
    pressUpdate();
    await flush();
    expect(rn.Linking.openURL).toHaveBeenCalledExactlyOnceWith(ANDROID_APP_STORE_URL);
  });

  it("lets a sideloaded user with no Play referrer download the APK", async () => {
    rn.Platform.OS = "android";
    getInstallReferrerAsync.mockResolvedValueOnce("");
    noteClientUpdateRequired();
    pressUpdate();
    await flush();

    expect(rn.Linking.openURL).not.toHaveBeenCalled();
    const buttons = rn.Alert.alert.mock.calls.at(-1)?.[2] as Array<{
      text: string;
      onPress: () => void;
    }>;
    expect(buttons.map(({ text }) => text)).toEqual(["Google Play", "Download APK"]);
    buttons[1]?.onPress();
    await flush();
    expect(rn.Linking.openURL).toHaveBeenCalledExactlyOnceWith(ANDROID_APK_URL);
  });

  it("offers Google Play when the Android referrer lookup fails", async () => {
    rn.Platform.OS = "android";
    getInstallReferrerAsync.mockRejectedValueOnce(new Error("Referrer unavailable"));
    noteClientUpdateRequired();
    pressUpdate();
    await flush();
    expect(rn.Alert.alert).toHaveBeenCalledTimes(2);
    expect(rn.Linking.openURL).not.toHaveBeenCalled();
    pressUpdate();
    await flush();
    expect(rn.Linking.openURL).toHaveBeenCalledExactlyOnceWith(ANDROID_APP_STORE_URL);
  });

  it("opens the store when no over-the-air update can fix it, and asks again next time", async () => {
    noteClientUpdateRequired();
    pressUpdate();
    await flush();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(rn.Linking.openURL).toHaveBeenCalledWith(IOS_APP_STORE_URL);
    noteClientUpdateRequired();
    expect(rn.Alert.alert).toHaveBeenCalledTimes(2);
  });
});

describe("foreground update checks", () => {
  it("downloads an update when the app returns from the background, at most every 15 minutes", async () => {
    let now = 0;
    const stop = watchForegroundUpdates(() => now);
    const emit = (state: string) => {
      for (const listener of [...rn.listeners]) listener(state);
    };
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
    now = FOREGROUND_UPDATE_CHECK_MS;
    emit("inactive");
    emit("active");
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    emit("background");
    emit("active");
    await flush();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    // Downloaded for the next launch; nothing reloads under the user.
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    now += FOREGROUND_UPDATE_CHECK_MS - 1;
    emit("background");
    emit("active");
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    stop();
    expect(rn.listeners).toHaveLength(0);
  });
});
