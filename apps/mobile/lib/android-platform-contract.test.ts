import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Android mobile platform contract", () => {
  it("keeps authentication actions reachable while the keyboard is open", () => {
    const signIn = readFileSync(resolve(mobileRoot, "app/sign-in.tsx"), "utf8");
    expect(signIn).toContain("KeyboardAvoidingView");
    expect(signIn).toContain("Keyboard.dismiss");
    expect(signIn).toContain("keyboardDismissMode");
    expect(signIn).toContain("ScrollView");
  });

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
    const allowlist = readFileSync(resolve(nativeRoot, "EndpointAllowlist.kt"), "utf8");
    const live = readFileSync(resolve(mobileRoot, "lib/live-notifications.ts"), "utf8");
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    expect(service).toContain("android.requestPromotedOngoing");
    expect(service).toContain("liveStatusIcon(primary, avatarStyle)");
    expect(service).toContain('rpc(endpoint, token, spaceId, "me"');
    expect(service).not.toContain("showStarting");
    expect(service).not.toContain("catch (_: IOException) {\n        stop()");
    expect(service).toContain("Expo push owns background completion and attention delivery");
    expect(service).toContain("isAllowedNotificationEndpoint(storage.endpoint)");
    expect(service).toContain("if (!isAllowedNotificationEndpoint(endpoint)) throw IOException");
    expect(module).toContain("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS");
    expect(module).not.toContain("settings.copy(liveConnection = false)");
    expect(module).toContain("RakazoNotificationService.clearSession(context)");
    expect(module).toContain("isAllowedNotificationEndpoint(endpoint)");
    expect(module).toContain("storage.spaceId = spaceId");
    expect(allowlist).toContain("isAllowedNotificationEndpoint");
    expect(allowlist).toContain('scheme == "https"');
    expect(allowlist).toContain("isLanOrLocalHost");
    expect(live).toContain("normalizeApiBase(endpoint)");
    expect(live).toMatch(
      /export async function resumeLiveNotifications[\s\S]*normalizeApiBase\(endpoint\)[\s\S]*nativeNotifications\.resume\(parsed\.url/,
    );
    expect(service).toContain('connection.setRequestProperty("x-rakazo-space-id", spaceId)');
    expect(service).toContain("storage.spaceId.isBlank()");
    expect(service).toContain("private fun prepareHistorySpace(");
    expect(service).toContain("knownCompleted.clear()");
    expect(service).toContain("alertedAttention.clear()");
    expect(service).toContain("SEEN_RUNS_SPACE_ID");
    expect(service).toContain(
      "getSharedPreferences(STATE_PREFERENCES, MODE_PRIVATE).edit().clear()",
    );
    expect(service).toContain("val generation = synchronized(sessionLock)");
    expect(service).toContain("ACTION_THREAD_CHANGED");
    expect(service).toContain(
      "private fun runIfCurrent(generation: Long, action: () -> Unit): Boolean",
    );
    expect(service).toContain("private fun stopIfCurrent(generation: Long)");
    expect(service).toContain("synchronized(sessionLock)");
    expect(service).toContain("working.filterNot(::isOpenThread)");
    expect(service).toContain("!run.notificationsEnabled || isOpenThread(run)");
    expect(service).toMatch(
      /waiting_input[\s\S]*filter \{ it\.notificationsEnabled \}[\s\S]*alertedAttention\.add/,
    );
    expect(service).toContain(
      "if (openThreadId != null) openThreadId == run.threadId else openBotId == run.botId",
    );
    expect(service).toContain("manager.notify(run.threadId.hashCode(), notification)");
    expect(service).toContain("THREAD_NOTIFICATION_IDS");
    expect(service).toContain("cancel(threadId.hashCode())");
    expect(module).toContain('AsyncFunction("setOpenThread")');
    expect(live).toContain("setOpenNotificationThread");
    expect(thread).toContain("if (!navigation.isFocused() || !notificationThreadId) return");
    expect(service).toContain(
      "fun clearSession(context: Context) {\n      synchronized(sessionLock)",
    );
    expect(service).not.toContain("private fun postCompletion(");
    expect(service).toContain('"rakazo://group-thread?groupId=');
    expect(service).toMatch(/&spaceId=\$\{Uri\.encode\(run\.spaceId\)\}/);
    expect(service).toContain('putString("rakazo.spaceId", run.spaceId)');
    expect(thread).toContain("export default function ThreadRoute()");
    expect(thread).toContain("selectSpace(requestedSpaceId)");
    expect(thread).toContain("routeMatchesSelectedSpace) return <Thread />");
    expect(service).toContain('if (run.groupId != null) put("groupId", run.groupId)');
    expect(service).toContain('if (message.optString("runId") != run.runId) continue');
    expect(service).toContain('if (block.optString("kind") == "handoff") return null');
    expect(service).toContain("run?.threadId?.hashCode() ?: 0");
  });

  it("shows live updates only for working runs and ties the pill to a real bot", () => {
    const service = readFileSync(
      resolve(
        mobileRoot,
        "modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications/RakazoNotificationService.kt",
      ),
      "utf8",
    );
    expect(service).toContain(
      "val working = active.filter(::isWorking).filter { it.notificationsEnabled }",
    );
    expect(service).toMatch(
      /if \(visibleWorking\.isEmpty\(\)\) clearLive\(\) else showLive\(visibleWorking/,
    );
    expect(service).toMatch(
      /private fun showLive\(active: List<RunRecord>[\s\S]*val primary = active\.first\(\)/,
    );
    expect(service).toContain('putString("rakazo.botId", run.botId)');
    expect(service).toMatch(/if \(working\.isEmpty\(\)\) \{[\s\S]*stop\(\)[\s\S]*return[\s\S]*\}/);
  });

  it("centers the latest-message control and clears a thread's Android notifications when read", () => {
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    const notifications = readFileSync(resolve(mobileRoot, "lib/live-notifications.ts"), "utf8");
    expect(thread).toContain('left: "50%"');
    expect(thread).toContain("dismissThreadNotifications");
    expect(notifications).toContain("getPresentedNotificationsAsync");
    expect(notifications).toContain("dismissNotificationAsync");
  });

  it("reconciles finished agents and opens ordinary chats at the latest message", () => {
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    const scroll = readFileSync(resolve(mobileRoot, "lib/thread-scroll.ts"), "utf8");
    expect(thread).toContain(
      "const currentBotStatus = snap ? snap.run?.status : currentBot?.status",
    );
    expect(thread).toContain("key={threadKey}");
    expect(scroll).toContain('this.contentReady && !this.currentState.detached ? "jump" : null');
  });

  it("stacks every currently working agent in a group footer", () => {
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    expect(thread).toContain("workingGroupBots.map");
    expect(thread).toContain("inGroup && workingGroupBots.length > 0 ?");
    expect(thread).toContain("workingGroupBots.length - index");
    expect(thread).toContain("agents working");
  });

  it("keeps send and stop separate while steering active work", () => {
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    const stopStart = thread.indexOf("async function stop()");
    const stopSource = thread.slice(stopStart, thread.indexOf("const answerMessage", stopStart));
    expect(stopStart).toBeGreaterThan(-1);
    expect(thread).toContain('accessibilityLabel={t("Send")}');
    expect(thread).toContain('accessibilityLabel={t("Stop")}');
    expect(thread).not.toContain("Messages sent now guide the next turn.");
    expect(thread).not.toContain("Steer ");
    expect(thread).not.toContain("steering message");
    expect(thread).toContain('t("Message {name}"');
    expect(thread).toContain("const clientNonce = newClientNonce()");
    expect(thread).toContain("Work stopped, but the thread could not refresh");
    expect(stopSource).toContain("const targetBotId = botId;");
    expect(stopSource).toContain("const targetGroupId = groupId;");
    expect(stopSource).toContain(
      "targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },",
    );
    expect(stopSource).toMatch(
      /if \(isCurrentTarget\(targetBotId, targetGroupId\)\) \{\s*setError\(err instanceof Error \? err\.message : t\("Failed to stop work"\)\);/,
    );
    expect(stopSource).toMatch(
      /if \(isCurrentTarget\(targetBotId, targetGroupId\)\) \{\s*(?:const detail = [^\n]+;\s*)?setError\(t\("Work stopped, but the thread could not refresh: \{detail\}", \{ detail \}\)\);/,
    );
  });

  it("shows agent notification silence in the menu, inbox avatar, and DM header only", () => {
    const index = readFileSync(resolve(mobileRoot, "app/index.tsx"), "utf8");
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    const avatar = readFileSync(resolve(mobileRoot, "components/bot-avatar.tsx"), "utf8");
    const menu = readFileSync(resolve(mobileRoot, "components/bot-organize-modal.tsx"), "utf8");
    expect(menu).toContain("Silence notifications");
    expect(menu).toContain("Resume notifications");
    expect(index).toContain("muted={!bot.notifyOnFinish}");
    expect(thread).toContain("muted={!currentBot.notifyOnFinish}");
    expect(avatar).toContain('accessibilityLabel={t("Notifications silenced")}');
    expect(avatar).toContain('android="notifications-off"');
    expect(thread.match(/muted=\{/g)).toHaveLength(1);
  });
});
