import { describe, expect, it, vi } from "vitest";
import {
  isMessagingEnabled,
  isMessagingSurfaceEnabled,
  type MessagingEnvironmentValues,
  messagingPlatformsFromEnv,
  parseSendblueStatus,
} from "./messaging-platforms.js";

// Fake credentials: adapters are constructed offline, never called.
const fullEnv: MessagingEnvironmentValues = {
  sendblueApiKeyId: "sb-key-id",
  sendblueApiSecret: "sb-secret",
  sendblueSigningSecret: "sb-signing",
  sendbluePhoneNumber: "+15550009999",
  slackBotToken: "xoxb-fake",
  slackSigningSecret: "slack-signing",
  whatsappAccessToken: "wa-token",
  whatsappPhoneNumberId: "wa-phone-id",
  whatsappAppSecret: "wa-app-secret",
  whatsappVerifyToken: "wa-verify",
  telegramBotToken: "tg-token",
  telegramWebhookSecret: "tg-webhook-secret",
};

function providers(env: MessagingEnvironmentValues): string[] {
  return messagingPlatformsFromEnv(env).map((platform) => platform.provider);
}

describe("messagingPlatformsFromEnv", () => {
  it("mounts nothing without credentials and everything with full credentials", () => {
    expect(providers({})).toEqual([]);
    expect(providers(fullEnv)).toEqual(["sendblue", "slack", "whatsapp", "telegram"]);
  });

  it("requires all four sendblue values", () => {
    for (const key of [
      "sendblueApiKeyId",
      "sendblueApiSecret",
      "sendblueSigningSecret",
      "sendbluePhoneNumber",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("sendblue");
    }
  });

  it("requires each platform's full credential set", () => {
    expect(providers({ ...fullEnv, slackSigningSecret: undefined })).not.toContain("slack");
    expect(providers({ ...fullEnv, slackBotToken: undefined })).not.toContain("slack");
    for (const key of [
      "whatsappAccessToken",
      "whatsappPhoneNumberId",
      "whatsappAppSecret",
      "whatsappVerifyToken",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("whatsapp");
    }
    expect(providers({ ...fullEnv, telegramBotToken: undefined })).not.toContain("telegram");
    // Without the secret token the adapter would accept unsigned webhook
    // posts, so the secret is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, telegramWebhookSecret: undefined })).not.toContain("telegram");
    expect(providers({ telegramBotToken: "tg-token" })).toEqual([]);
    expect(
      providers({ telegramBotToken: "tg-token", telegramWebhookSecret: "tg-webhook-secret" }),
    ).toEqual(["telegram"]);
  });

  it("forces Telegram into webhook mode so worker initialize cannot long-poll", () => {
    const telegram = messagingPlatformsFromEnv({
      telegramBotToken: "tg-token",
      telegramWebhookSecret: "tg-webhook-secret",
    })[0]!;
    // mode is protected on the adapter class but readable at runtime.
    expect((telegram.adapter as unknown as { mode: string }).mode).toBe("webhook");
  });

  it("declares group and typing support only for sendblue", () => {
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const capabilities = Object.fromEntries(
      platforms.map((platform) => [platform.provider, platform.capabilities]),
    );
    expect(capabilities.sendblue).toEqual({ direct: true, groups: true, typing: true });
    expect(capabilities.slack).toEqual({ direct: true, groups: false, typing: false });
    expect(capabilities.whatsapp).toEqual({ direct: true, groups: false, typing: false });
    expect(capabilities.telegram).toEqual({ direct: true, groups: false, typing: false });
  });
});

describe("sendblue platform hooks", () => {
  const sendblue = messagingPlatformsFromEnv(fullEnv)[0]!;

  it("filters the deployment line and non-string entries out of the roster", () => {
    expect(
      sendblue.participants!({
        participants: ["+15551111111", "+15550009999", 42, null, "+15552222222"],
      }),
    ).toEqual(["+15551111111", "+15552222222"]);
    expect(sendblue.participants!({ participants: "not-a-list" })).toEqual([]);
    expect(sendblue.participants!(null)).toEqual([]);
  });

  it("reads the group display name only when present", () => {
    expect(sendblue.channelName!({ group_display_name: "Family" })).toBe("Family");
    expect(sendblue.channelName!({ group_display_name: "" })).toBeNull();
    expect(sendblue.channelName!({})).toBeNull();
    expect(sendblue.channelName!(null)).toBeNull();
  });

  it("derives deterministic provider-prefixed direct thread ids", () => {
    expect(sendblue.directThreadId!("+15551234567")).toMatch(/^sendblue:/);
    expect(sendblue.adapter.isDM?.(sendblue.directThreadId!("+15551234567"))).toBe(true);
  });
});

describe("parseSendblueStatus", () => {
  const statusPayload = {
    content: "",
    is_outbound: true,
    status: "DELIVERED",
    message_handle: "handle-1",
    from_number: "+15550009999",
  };

  it("normalizes outbound delivery webhooks", () => {
    expect(parseSendblueStatus(statusPayload)).toEqual({
      type: "status",
      provider: "sendblue",
      handle: "handle-1",
      status: "DELIVERED",
    });
    expect(parseSendblueStatus({ ...statusPayload, status: 7 })).toEqual(
      expect.objectContaining({ status: "" }),
    );
  });

  it("ignores inbound and malformed payloads", () => {
    expect(parseSendblueStatus({ ...statusPayload, is_outbound: false })).toBeNull();
    expect(parseSendblueStatus({ ...statusPayload, message_handle: "" })).toBeNull();
    const { message_handle: _dropped, ...withoutHandle } = statusPayload;
    expect(parseSendblueStatus(withoutHandle)).toBeNull();
    expect(parseSendblueStatus(null)).toBeNull();
    expect(parseSendblueStatus("nope")).toBeNull();
  });
});

describe("isMessagingEnabled", () => {
  it("requires at least one platform", () => {
    vi.stubEnv("VITEST", "");
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    expect(isMessagingEnabled([])).toBe(false);
    vi.unstubAllEnvs();
  });

  it("is disabled under vitest even with platforms configured", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(false);
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("isMessagingSurfaceEnabled", () => {
  it("requires the deployment model key only for open signup", () => {
    vi.stubEnv("VITEST", "");
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const key = (deploymentModelKey: string | undefined, openSignup: boolean) => ({
      deploymentModelKey,
      openSignup,
    });
    // Open signup provisions users with no credentials of their own.
    expect(isMessagingSurfaceEnabled(platforms, key("model-key", true))).toBe(true);
    expect(isMessagingSurfaceEnabled(platforms, key(undefined, true))).toBe(false);
    // Linking-only deployments run linked users on their own credentials.
    expect(isMessagingSurfaceEnabled(platforms, key(undefined, false))).toBe(true);
    expect(isMessagingSurfaceEnabled([], key("model-key", true))).toBe(false);
    vi.unstubAllEnvs();
  });
});
