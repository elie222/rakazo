import { getLogger } from "@rakazo/logging";
import { Domain } from "chat-adapter-lark";
import { describe, expect, it, vi } from "vitest";
import {
  enrichSlackTeamRoom,
  isMessagingEnabled,
  isMessagingSurfaceEnabled,
  type MessagingEnvironmentValues,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  parseSendblueStatus,
  telegramBotsFromEnv,
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
  larkAppId: "cli-fake",
  larkAppSecret: "lark-secret",
  larkVerificationToken: "lark-verify",
};

function providers(env: MessagingEnvironmentValues): string[] {
  return messagingPlatformsFromEnv(env).map((platform) => platform.provider);
}

describe("messagingPlatformsFromEnv", () => {
  it("mounts nothing without credentials and everything with full credentials", () => {
    expect(providers({})).toEqual([]);
    expect(providers(fullEnv)).toEqual(["sendblue", "slack", "whatsapp", "telegram", "lark"]);
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
    expect(providers({ ...fullEnv, larkAppId: undefined })).not.toContain("lark");
    expect(providers({ ...fullEnv, larkAppSecret: undefined })).not.toContain("lark");
    // Without the verification token the adapter would accept unsigned
    // webhook posts, so the token is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, larkVerificationToken: undefined })).not.toContain("lark");
    expect(providers({ larkAppId: "cli-fake", larkAppSecret: "lark-secret" })).toEqual([]);
    expect(
      providers({
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }),
    ).toEqual(["lark"]);
  });

  it("forces Telegram into webhook mode so worker initialize cannot long-poll", () => {
    const telegram = messagingPlatformsFromEnv({
      telegramBotToken: "tg-token",
      telegramWebhookSecret: "tg-webhook-secret",
    })[0]!;
    // mode is protected on the adapter class but readable at runtime.
    expect((telegram.adapter as unknown as { mode: string }).mode).toBe("webhook");
  });

  it("mounts each named Telegram bot as its own telegram-<name> provider", () => {
    const platforms = messagingPlatformsFromEnv({
      telegramBotToken: "tg-token",
      telegramWebhookSecret: "tg-webhook-secret",
      telegramBots: [{ name: "work", botToken: "tg-work", webhookSecret: "tg-work-secret" }],
    });
    expect(platforms.map((platform) => [platform.provider, platform.adapterName])).toEqual([
      ["telegram", undefined],
      ["telegram-work", "telegram"],
    ]);
    expect((platforms[1]!.adapter as unknown as { mode: string }).mode).toBe("webhook");
  });

  it("reads named Telegram bots from TELEGRAM_BOT_TOKEN_<NAME> pairs", () => {
    expect(
      telegramBotsFromEnv({
        TELEGRAM_BOT_TOKEN: "default",
        TELEGRAM_WEBHOOK_SECRET_TOKEN: "default-secret",
        TELEGRAM_BOT_TOKEN_WORK: " tg-work ",
        TELEGRAM_WEBHOOK_SECRET_TOKEN_WORK: " work-secret ",
        TELEGRAM_BOT_TOKEN_HOME2: "tg-home",
        TELEGRAM_WEBHOOK_SECRET_TOKEN_HOME2: "home-secret",
        // Unsigned webhooks would be accepted, so a name without a secret stays off.
        TELEGRAM_BOT_TOKEN_NOSECRET: "tg-nosecret",
        TELEGRAM_BOT_TOKEN_BAD_NAME: "tg-bad",
        TELEGRAM_WEBHOOK_SECRET_TOKEN_BAD_NAME: "bad-secret",
      }),
    ).toEqual([
      { name: "home2", botToken: "tg-home", webhookSecret: "home-secret" },
      { name: "work", botToken: "tg-work", webhookSecret: "work-secret" },
    ]);
  });

  it("skips a named Telegram bot that reuses the default or another bot's token", () => {
    expect(
      providers(
        messagingEnvFromProcess({
          TELEGRAM_BOT_TOKEN: "tg-shared",
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "default-secret",
          TELEGRAM_BOT_TOKEN_COPY: " tg-shared ",
          TELEGRAM_WEBHOOK_SECRET_TOKEN_COPY: "copy-secret",
          TELEGRAM_BOT_TOKEN_ALPHA: "tg-other",
          TELEGRAM_WEBHOOK_SECRET_TOKEN_ALPHA: "alpha-secret",
          TELEGRAM_BOT_TOKEN_BETA: "tg-other",
          TELEGRAM_WEBHOOK_SECRET_TOKEN_BETA: "beta-secret",
        }),
      ),
    ).toEqual(["telegram", "telegram-alpha"]);
  });

  it("keeps the first named token when mounting credentials directly", () => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      expect(
        providers({
          telegramBots: [
            { name: "first", botToken: "tg-shared", webhookSecret: "first-secret" },
            { name: "second", botToken: " tg-shared ", webhookSecret: "second-secret" },
          ],
        }),
      ).toEqual(["telegram-first"]);
      expect(warn).toHaveBeenCalledWith("skipping Telegram bot that reuses another bot's token", {
        provider: "telegram-second",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("tg-shared");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([undefined, "", "   "])(
    "does not reserve an incomplete default bot's token (%s)",
    (secret) => {
      expect(
        providers(
          messagingEnvFromProcess({
            TELEGRAM_BOT_TOKEN: "tg-shared",
            TELEGRAM_WEBHOOK_SECRET_TOKEN: secret,
            TELEGRAM_BOT_TOKEN_WORK: "tg-shared",
            TELEGRAM_WEBHOOK_SECRET_TOKEN_WORK: "work-secret",
          }),
        ),
      ).toEqual(["telegram-work"]);
    },
  );

  it("forces Lark into webhook inbound so worker initialize cannot open a long connection", () => {
    const lark = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
    })[0]!;
    const incoming = lark.adapter as unknown as {
      incomingConfig: { events: string; callbacks: string };
      shouldStartWsClient: () => boolean;
    };
    expect(incoming.incomingConfig).toEqual({ events: "webhook", callbacks: "webhook" });
    expect(incoming.shouldStartWsClient()).toBe(false);
  });

  it("maps LARK_* process env and accepts the international domain switch", () => {
    expect(
      messagingEnvFromProcess({
        LARK_APP_ID: " cli-fake ",
        LARK_APP_SECRET: " lark-secret ",
        LARK_VERIFICATION_TOKEN: " lark-verify ",
        LARK_ENCRYPT_KEY: " lark-encrypt ",
        LARK_DOMAIN: " Lark ",
      }),
    ).toMatchObject({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkEncryptKey: "lark-encrypt",
      larkDomain: "Lark",
    });
    const international = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkDomain: "Lark",
    })[0]!;
    expect((international.adapter as unknown as { config: { domain: Domain } }).config.domain).toBe(
      Domain.Lark,
    );
  });

  it.each(["", "unknown", "feishu"])("uses normalized Lark defaults for domain %s", (domain) => {
    vi.stubEnv("LARK_DOMAIN", domain);
    vi.stubEnv("LARK_ENCRYPT_KEY", "   ");
    try {
      const lark = messagingPlatformsFromEnv({
        ...messagingEnvFromProcess(process.env),
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }).find((platform) => platform.provider === "lark")!;
      const config = (
        lark.adapter as unknown as {
          config: { domain: Domain; encryptKey: string };
        }
      ).config;
      expect(config.domain).toBe(Domain.Feishu);
      expect(config.encryptKey).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("declares group support and the receipt for each platform", () => {
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const capabilities = Object.fromEntries(
      platforms.map((platform) => [platform.provider, platform.capabilities]),
    );
    expect(capabilities.sendblue).toEqual({ direct: true, groups: true, receipt: "typing" });
    expect(capabilities.slack).toEqual({ direct: true, groups: true, receipt: "reaction" });
    expect(capabilities.whatsapp).toEqual({ direct: true, groups: false, receipt: null });
    expect(capabilities.telegram).toEqual({ direct: true, groups: false, receipt: null });
    expect(capabilities.lark).toEqual({ direct: true, groups: false, receipt: null });
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

  it("accepts only supported per-message transports", () => {
    for (const service of ["iMessage", "SMS", "RCS"]) {
      expect(sendblue.transport!({ service })).toBe(service);
    }
    expect(sendblue.transport!({ service: "email" })).toBeNull();
    expect(sendblue.transport!({ service: 42 })).toBeNull();
    expect(sendblue.transport!(null)).toBeNull();
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
  it("requires a configured deployment model only for open signup", () => {
    vi.stubEnv("VITEST", "");
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const options = (deploymentModelConfigured: boolean, openSignup: boolean) => ({
      deploymentModelConfigured,
      openSignup,
    });
    // Open signup provisions users with no credentials of their own.
    expect(isMessagingSurfaceEnabled(platforms, options(true, true))).toBe(true);
    expect(isMessagingSurfaceEnabled(platforms, options(false, true))).toBe(false);
    // Linking-only deployments run linked users on their own credentials.
    expect(isMessagingSurfaceEnabled(platforms, options(false, false))).toBe(true);
    expect(isMessagingSurfaceEnabled([], options(true, true))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("enrichSlackTeamRoom", () => {
  const base = {
    type: "message" as const,
    provider: "slack",
    handle: "Ev1",
    threadId: "slack:C1",
    isDirect: false,
    from: "U_OTHER",
    fromLabel: "Ada",
    channelName: "launch",
    participants: ["U_OTHER"],
    content: "hello <@U_SOMEONE>",
    mediaUrl: null,
  };

  it("marks app_mention events as mention", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: { type: "app_mention", channel: "C1", text: "<@U_BOT> ship it", user: "U_OTHER" },
      },
      base,
    );
    expect(enrichment.kind).toBe("mention");
    expect(enrichment.workspaceId).toBe("T1");
    expect(enrichment.conversationKey).toBe("C1");
  });

  it("keeps ambient when another user is mentioned, not the bot", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: {
          type: "message",
          channel: "C1",
          text: "hey <@U_SOMEONE> can you look?",
          user: "U_OTHER",
        },
      },
      base,
    );
    expect(enrichment.kind).toBe("ambient");
  });

  it("marks a plain message event as mention when the platform reports a bot mention", () => {
    const raw = {
      type: "message",
      channel: "C1",
      text: "<@U_BOT> respond back please?",
      user: "U_OTHER",
      team: "T1",
    };
    expect(enrichSlackTeamRoom(raw, { ...base, mentionsBot: true }).kind).toBe("mention");
    expect(enrichSlackTeamRoom(raw, base).kind).toBe("ambient");
  });
});
