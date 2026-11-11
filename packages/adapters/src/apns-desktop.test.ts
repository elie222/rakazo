import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApnsDesktopProvider } from "./apns-desktop.js";
import { apnsDesktopConfig } from "./apns-desktop-config.js";
import type { ApnsTransport } from "./apns-voip.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = {
  keyId: "test-key",
  teamId: "test-team",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  environment: "production" as const,
  bundleId: "test.desktop",
};
const message = {
  kind: "help" as const,
  title: "Scout needs an answer",
  body: "Which flight?",
  botId: "bot-1",
  threadId: "thread-1",
  badge: 3,
  sender: { botId: "bot-1", name: "Scout", avatar: "picture" },
};

describe("APNs desktop alerts", () => {
  it("sends an alert to the desktop app's topic with the chat to open", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    const push = new ApnsDesktopProvider(config, transport);
    expect(await push.send("fake-device-token", message, "space-1")).toBe("sent");
    const [origin, headers, body] = transport.mock.calls[0]!;
    expect(origin).toBe("https://api.push.apple.com");
    expect(headers).toMatchObject({
      ":path": "/3/device/fake-device-token",
      "apns-topic": "test.desktop",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "thread-1",
    });
    expect(headers.authorization).toMatch(/^bearer /);
    const payload = JSON.parse(body);
    expect(payload.aps).toEqual({
      alert: { title: "Scout needs an answer", body: "Which flight?" },
      sound: "default",
      "thread-id": "thread-1",
      badge: 3,
    });
    expect(payload).toMatchObject({ botId: "bot-1", threadId: "thread-1", spaceId: "space-1" });
    expect(body).not.toContain("picture");
  });

  it("sends a finished reply at normal priority and groups a group chat's alerts", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    await new ApnsDesktopProvider(config, transport).send(
      "fake",
      { ...message, kind: "completion", groupId: "group-1" },
      "space-1",
    );
    const [, headers, body] = transport.mock.calls[0]!;
    expect(headers["apns-priority"]).toBe("5");
    expect(JSON.parse(body).aps["thread-id"]).toBe("group-1");
  });

  it.each([
    [{ status: 410 }, "invalid"],
    [{ status: 400, reason: "Unregistered" }, "invalid"],
    // Also returned for a sandbox/production mismatch, which must not drop every token.
    [{ status: 400, reason: "BadDeviceToken" }, "failed"],
  ] as const)("classifies %j as %s", async (reply, result) => {
    expect(
      await new ApnsDesktopProvider(config, async () => reply).send("fake", message, "s"),
    ).toBe(result);
  });

  it("reports a network failure without throwing", async () => {
    const transport = vi.fn<ApnsTransport>().mockRejectedValue(new Error("offline"));
    expect(await new ApnsDesktopProvider(config, transport).send("fake", message, "s")).toBe(
      "failed",
    );
  });
});

describe("APNs desktop configuration", () => {
  const key = {
    APNS_VOIP_KEY_ID: "key",
    APNS_VOIP_TEAM_ID: "team",
    APNS_VOIP_PRIVATE_KEY: "line1\\nline2",
    APNS_VOIP_ENVIRONMENT: "sandbox",
  };

  it("is off without the team's APNs key", () => {
    expect(apnsDesktopConfig({ APNS_DESKTOP_BUNDLE_ID: "test.desktop" })).toBeUndefined();
  });

  it("signs with the shared key, in its own environment and topic", () => {
    expect(apnsDesktopConfig(key)).toEqual({
      keyId: "key",
      teamId: "team",
      privateKey: "line1\nline2",
      environment: "production",
      bundleId: "dev.rakazo.desktop",
    });
    expect(
      apnsDesktopConfig({
        ...key,
        APNS_DESKTOP_ENVIRONMENT: "sandbox",
        APNS_DESKTOP_BUNDLE_ID: "test.desktop",
      }),
    ).toMatchObject({ environment: "sandbox", bundleId: "test.desktop" });
    expect(() => apnsDesktopConfig({ ...key, APNS_DESKTOP_ENVIRONMENT: "staging" })).toThrow(
      /sandbox or production/,
    );
  });
});
