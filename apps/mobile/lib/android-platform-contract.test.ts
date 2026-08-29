import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Android mobile platform contract", () => {
  it("pins the thread footer above the keyboard and device safe area", () => {
    const config = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8"));
    const packageJson = JSON.parse(readFileSync(resolve(mobileRoot, "package.json"), "utf8"));
    const layout = readFileSync(resolve(mobileRoot, "app/_layout.tsx"), "utf8");
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    expect(config.expo.android.softwareKeyboardLayoutMode).toBe("resize");
    expect(packageJson.dependencies["react-native-keyboard-controller"]).toBeTruthy();
    expect(layout).toContain("KeyboardProvider");
    expect(thread).toContain('from "react-native-keyboard-controller"');
    expect(thread).toContain("KeyboardAvoidingView");
    expect(thread).toContain('behavior="height"');
    expect(thread).toContain("useHeaderHeight");
    expect(thread).toContain("keyboardVerticalOffset={headerHeight}");
    expect(thread).not.toContain("automaticOffset");
    expect(thread).not.toContain("KeyboardStickyView");
    expect(thread).toContain("useSafeAreaInsets");
    expect(thread).toContain("Math.max(insets.bottom + 12, 24)");
  });

  it("requests live-update promotion and exposes its Android settings", () => {
    const nativeRoot = resolve(
      mobileRoot,
      "modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications",
    );
    const service = readFileSync(resolve(nativeRoot, "RakazoNotificationService.kt"), "utf8");
    const module = readFileSync(resolve(nativeRoot, "RakazoNotificationsModule.kt"), "utf8");
    expect(service).toContain("android.requestPromotedOngoing");
    expect(service).toContain("liveStatusIcon(primary, avatarStyle)");
    expect(service).toContain('rpc(endpoint, token, "me"');
    expect(service).not.toContain("showStarting");
    expect(service).not.toContain("if (active.isEmpty())");
    expect(service).not.toContain("catch (_: IOException) {\n        stop()");
    expect(module).toContain("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS");
    expect(module).not.toContain("settings.copy(liveConnection = false)");
  });

  it("shows live updates only for working runs and ties the pill to a real bot", () => {
    const service = readFileSync(
      resolve(
        mobileRoot,
        "modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications/RakazoNotificationService.kt",
      ),
      "utf8",
    );
    expect(service).toContain("val working = active.filter(::isWorking)");
    expect(service).toContain("val primary = active.first()\n");
    expect(service).toContain('putString("rakazo.botId", run.botId)');
  });

  it("centers the latest-message control and clears a thread's Android notifications when read", () => {
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    const notifications = readFileSync(resolve(mobileRoot, "lib/live-notifications.ts"), "utf8");
    expect(thread).toContain('left: "50%"');
    expect(thread).toContain("dismissThreadNotifications");
    expect(notifications).toContain("getPresentedNotificationsAsync");
    expect(notifications).toContain("dismissNotificationAsync");
  });
});
