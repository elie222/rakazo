import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeApiBase } from "./endpoint.js";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Android mobile platform contract", () => {
  it("shares its notification endpoint cases with the app's server URL check", () => {
    const cases: [string, boolean][] = JSON.parse(
      readFileSync(
        resolve(
          mobileRoot,
          "modules/rakazo-notifications/android/src/test/resources/endpoint-allowlist-cases.json",
        ),
        "utf8",
      ),
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const [endpoint, allowed] of cases) {
      expect({ endpoint, allowed: normalizeApiBase(endpoint).ok }).toEqual({ endpoint, allowed });
    }
  });

  it("requests live-update promotion and exposes its Android settings", () => {
    const nativeRoot = resolve(
      mobileRoot,
      "modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications",
    );
    const service = readFileSync(resolve(nativeRoot, "RakazoNotificationService.kt"), "utf8");
    const module = readFileSync(resolve(nativeRoot, "RakazoNotificationsModule.kt"), "utf8");
    const allowlist = readFileSync(resolve(nativeRoot, "EndpointAllowlist.kt"), "utf8");
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
    expect(service).toContain("createConfigurationContext");
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
    for (const request of [
      "        val avatarStyle = selectedAvatarStyle",
      "        val active = runs(",
      "        val recent = runs(",
      "          val reply = runCatching {",
    ]) {
      expect(service).toContain(`if (generation != sessionGeneration.get()) return\n${request}`);
    }
    expect(service).toContain("runCatching { context.startService(intent) }");
    expect(module).toContain('AsyncFunction("setOpenThread")');
    expect(service).toContain(
      "fun clearSession(context: Context) {\n      synchronized(sessionLock)",
    );
    expect(service).not.toContain("private fun postCompletion(");
    expect(service).toContain('"rakazo://group-thread?groupId=');
    expect(service).toMatch(/&spaceId=\$\{Uri\.encode\(run\.spaceId\)\}/);
    expect(service).toContain('putString("rakazo.spaceId", run.spaceId)');
    expect(service).toMatch(/&threadId=\$\{Uri\.encode\(run\.threadId\)\}/);
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
      /if \(visibleWorking\.isEmpty\(\)\) clearLive\(\) else \{[\s\S]*showLive\(visibleWorking, avatarStyle, copyContext\)/,
    );
    expect(service).toMatch(
      /private fun showLive\(active: List<RunRecord>[\s\S]*val primary = active\.first\(\)/,
    );
    expect(service).toContain('putString("rakazo.botId", run.botId)');
    expect(service).toMatch(/if \(working\.isEmpty\(\)\) \{[\s\S]*stop\(\)[\s\S]*return[\s\S]*\}/);
  });

  it("keeps markdown boundary checks portable to Android and preserves Unicode whitespace edges", () => {
    const service = readFileSync(
      resolve(
        mobileRoot,
        "modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications/RakazoNotificationService.kt",
      ),
      "utf8",
    );

    // Desktop Java accepts (?U), so a JVM-only regex test would miss Android's
    // ICU parser failure. Keep the exact native source under the Android
    // contract test and exercise the equivalent boundary semantics here.
    const slash = String.fromCharCode(92);
    const quote = String.fromCharCode(34);
    const unicodeWhiteSpaceClass = `${slash}${slash}p{Z}${slash}${slash}u0009-${slash}${slash}u000D${slash}${slash}u0085`;
    expect(service).toContain(
      `private val NON_SPACE_AT_END = Regex(${quote}[^${unicodeWhiteSpaceClass}]${slash}${slash}z${quote})`,
    );
    expect(service).toContain(
      `private val NON_SPACE_AT_START = Regex(${quote}^[^${unicodeWhiteSpaceClass}]${quote})`,
    );
    expect(service).not.toMatch(/Regex\(\s*["']\(\?U\)/);

    const javascriptUnicodeWhiteSpaceClass = `${slash}p{Separator}${slash}u0009-${slash}u000D${slash}u0085`;
    const nonSpaceAtEnd = new RegExp(`[^${javascriptUnicodeWhiteSpaceClass}]$`, "u");
    const nonSpaceAtStart = new RegExp(`^[^${javascriptUnicodeWhiteSpaceClass}]`, "u");
    const unicodeWhiteSpace = [
      "\u0009",
      "\u000A",
      "\u000B",
      "\u000C",
      "\u000D",
      "\u0020",
      "\u0085",
      "\u00A0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200A",
      "\u2028",
      "\u2029",
      "\u202F",
      "\u205F",
      "\u3000",
    ];

    for (const whitespace of unicodeWhiteSpace) {
      expect(nonSpaceAtEnd.test(`text${whitespace}`)).toBe(false);
      expect(nonSpaceAtStart.test(`${whitespace}text`)).toBe(false);
    }
    expect(nonSpaceAtEnd.test("text")).toBe(true);
    expect(nonSpaceAtStart.test("text")).toBe(true);
    // Zero-width space is not in Unicode White_Space and must remain content.
    expect(nonSpaceAtEnd.test("text\u200B")).toBe(true);
    expect(nonSpaceAtStart.test("\u200Btext")).toBe(true);
  });
});
