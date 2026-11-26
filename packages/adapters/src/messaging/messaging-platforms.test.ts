import { validateFileSize, WhatsAppApiError } from "@chat-adapter/whatsapp";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { SendblueAdapter } from "chat-adapter-sendblue";
import { describe, expect, it, vi } from "vitest";
import { Domain } from "../providers/messaging/lark/thread-id.js";
import { photonProjectsFromEnv } from "../providers/messaging/photon/photon-messaging.js";
import { parseSendblueStatuses } from "../providers/messaging/sendblue/sendblue-messaging.js";
import {
  enrichSlackTeamRoom,
  SLACK_MARKDOWN_LIMIT,
  slackOutbound,
  slackPayloads,
} from "../providers/messaging/slack/slack-messaging.js";
import {
  telegramBotsFromEnv,
  telegramOutbound,
} from "../providers/messaging/telegram/telegram-messaging.js";
import {
  parseWhatsAppStatuses,
  whatsappOutbound,
} from "../providers/messaging/whatsapp/whatsapp-messaging.js";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import type { MessagingEnvironmentValues } from "./messaging-platforms.js";
import {
  isMessagingEnabled,
  isMessagingSurfaceEnabled,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  splitOutboundBody,
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
  photonProjectId: "photon-project",
  photonProjectSecret: "photon-secret",
};

function providers(env: MessagingEnvironmentValues): string[] {
  return messagingPlatformsFromEnv(env).map((platform) => platform.provider);
}

describe("messagingPlatformsFromEnv", () => {
  it("mounts nothing without credentials and everything with full credentials", () => {
    expect(providers({})).toEqual([]);
    expect(providers(fullEnv)).toEqual([
      "sendblue",
      "slack",
      "whatsapp",
      "telegram",
      "lark",
      "photon",
    ]);
  });

  it("publishes the iMessage line so people know where to send a link code", () => {
    const addresses = Object.fromEntries(
      messagingPlatformsFromEnv(fullEnv).map((platform) => [platform.provider, platform.address]),
    );
    expect(addresses.sendblue).toBe("+15550009999");
    expect(addresses.slack).toBeUndefined();
  });

  it.each([
    undefined,
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    "https://api.example.test",
  ])("preserves automatic receiving without inferring webhook registration from %s", (apiUrl) => {
    const credentials = {
      telegramBotToken: "fake-token",
      telegramWebhookSecret: "fake-secret",
      telegramBots: [{ name: "support", botToken: "fake-support", webhookSecret: "fake-secret" }],
      inboundOrigin: apiUrl,
    };
    const modes = (pollInboundMessages: boolean) =>
      messagingPlatformsFromEnv(credentials, { pollInboundMessages }).map(
        ({ adapter }) => (adapter as unknown as { mode: string }).mode,
      );
    expect(modes(true)).toEqual(["auto", "auto"]);
    expect(modes(false)).toEqual(["webhook", "webhook"]);
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
    expect(platforms[1]!.capabilities.files).toBe(true);
    expect(platforms[1]!.capabilities.groups).toBe(true);
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

  it("mounts each named Photon project as its own photon-<name> provider", () => {
    const platforms = messagingPlatformsFromEnv(
      {
        photonProjectId: "photon-project",
        photonProjectSecret: "photon-secret",
        photonProjects: [
          { name: "pm", projectId: "photon-pm", projectSecret: "pm-secret" },
          {
            name: "am",
            projectId: "photon-am",
            projectSecret: "am-secret",
            webhookSecret: "am-hook",
          },
        ],
      },
      { pollInboundMessages: true },
    );
    expect(platforms.map((platform) => [platform.provider, platform.adapterName])).toEqual([
      ["photon", "imessage"],
      ["photon-pm", "imessage"],
      ["photon-am", "imessage"],
    ]);
    const config = (index: number) =>
      (platforms[index]!.adapter as unknown as { config: Record<string, unknown> }).config;
    expect(config(1)).toMatchObject({ projectId: "photon-pm", pollInboundMessages: true });
    expect(config(2)).toMatchObject({ projectId: "photon-am", webhookSecret: "am-hook" });
  });

  it("reads named Photon projects from PHOTON_PROJECT_ID_<NAME> pairs", () => {
    expect(
      photonProjectsFromEnv({
        PHOTON_PROJECT_ID: "default",
        PHOTON_PROJECT_SECRET: "default-secret",
        PHOTON_PROJECT_ID_PM: " photon-pm ",
        PHOTON_PROJECT_SECRET_PM: " pm-secret ",
        PHOTON_PROJECT_ID_AM: "photon-am",
        PHOTON_PROJECT_SECRET_AM: "am-secret",
        PHOTON_WEBHOOK_SECRET_AM: " am-hook ",
        PHOTON_PROJECT_ID_NOSECRET: "photon-nosecret",
        PHOTON_PROJECT_ID_BAD_NAME: "photon-bad",
        PHOTON_PROJECT_SECRET_BAD_NAME: "bad-secret",
      }),
    ).toEqual([
      { name: "am", projectId: "photon-am", projectSecret: "am-secret", webhookSecret: "am-hook" },
      { name: "pm", projectId: "photon-pm", projectSecret: "pm-secret", webhookSecret: undefined },
    ]);
  });

  it("skips a named Photon project that reuses another provider's project", () => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      expect(
        providers(
          messagingEnvFromProcess({
            PHOTON_PROJECT_ID: "photon-shared",
            PHOTON_PROJECT_SECRET: "default-secret",
            PHOTON_PROJECT_ID_COPY: " photon-shared ",
            PHOTON_PROJECT_SECRET_COPY: "copy-secret",
            PHOTON_PROJECT_ID_PM: "photon-pm",
            PHOTON_PROJECT_SECRET_PM: "pm-secret",
          }),
        ),
      ).toEqual(["photon", "photon-pm"]);
      expect(warn).toHaveBeenCalledWith(
        "skipping Photon project that reuses another provider's project",
        { provider: "photon-copy" },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("photon-shared");
    } finally {
      warn.mockRestore();
    }
  });

  it("requires both Photon credentials and maps PHOTON_* process env", () => {
    expect(providers({ ...fullEnv, photonProjectSecret: undefined })).not.toContain("photon");
    expect(providers({ ...fullEnv, photonProjectId: undefined })).not.toContain("photon");
    expect(
      messagingEnvFromProcess({
        PHOTON_PROJECT_ID: " photon-project ",
        PHOTON_PROJECT_SECRET: " photon-secret ",
        PHOTON_WEBHOOK_SECRET: " ",
      }),
    ).toMatchObject({
      photonProjectId: "photon-project",
      photonProjectSecret: "photon-secret",
      photonWebhookSecret: undefined,
    });
  });

  it("streams Photon inbound only in the process that owns the inbound sink", () => {
    const photon = (pollInboundMessages?: boolean) =>
      (
        messagingPlatformsFromEnv(
          { photonProjectId: "photon-project", photonProjectSecret: "photon-secret" },
          pollInboundMessages === undefined ? {} : { pollInboundMessages },
        )[0]!.adapter as unknown as { config: { pollInboundMessages: boolean } }
      ).config.pollInboundMessages;
    expect(photon()).toBe(false);
    expect(photon(true)).toBe(true);
  });

  it("forces Lark into webhook inbound so worker initialize cannot open a long connection", () => {
    const lark = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
    })[0]!;
    const incoming = lark.adapter as unknown as {
      incomingConfig: { events: string; callbacks: string };
    };
    expect(incoming.incomingConfig).toEqual({ events: "webhook", callbacks: "webhook" });
    expect("shouldStartWsClient" in incoming).toBe(false);
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

  it.each(["", "feishu"])("uses normalized Lark defaults for domain %s", (domain) => {
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

  it("declares which platforms read markdown, split a long body and cap an upload", () => {
    const mounted = Object.fromEntries(
      messagingPlatformsFromEnv(fullEnv).map((platform) => [platform.provider, platform]),
    );
    const property = (name: "markdown" | "split") =>
      Object.entries(mounted)
        .filter(([, platform]) => Boolean(platform.outbound?.[name]))
        .map(([provider]) => provider)
        .sort();
    expect(property("markdown")).toEqual(["lark", "photon", "slack", "telegram", "whatsapp"]);
    // Only the platforms that own a limit have a splitter, so nothing is split by accident.
    expect(property("split")).toEqual(["slack", "telegram", "whatsapp"]);
    expect(mounted.telegram?.outbound?.attachmentLimitBytes).toBe(50_000_000);
    expect(mounted.telegram?.outbound?.photo?.maxBytes).toBe(10_000_000);
    // Sendblue sends plain text as one message: it declares no facts at all.
    expect(mounted.sendblue?.outbound).toBeUndefined();
  });

  it("declares group support, the receipt and file support for each platform", () => {
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const capabilities = Object.fromEntries(
      platforms.map((platform) => [platform.provider, platform.capabilities]),
    );
    expect(capabilities.sendblue).toEqual({ direct: true, groups: true, receipt: "typing" });
    expect(capabilities.slack).toEqual({ direct: true, groups: true, receipt: "reaction" });
    expect(capabilities.whatsapp).toEqual({
      direct: true,
      groups: false,
      receipt: null,
      files: true,
    });
    expect(capabilities.telegram).toEqual({
      direct: true,
      groups: true,
      receipt: null,
      files: true,
    });
    expect(capabilities.lark).toEqual({ direct: true, groups: false, receipt: null });
    expect(capabilities.photon).toEqual({ direct: true, groups: false, receipt: "typing" });
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

  it("takes the roster's time from the message's send time", () => {
    expect(sendblue.rosterAt!({ date_sent: "2026-11-04T10:01:00.000Z" })).toEqual(
      new Date("2026-11-04T10:01:00.000Z"),
    );
    expect(sendblue.rosterAt!({ date_sent: "not-a-date" })).toBeNull();
    expect(sendblue.rosterAt!({ date_sent: 42 })).toBeNull();
    expect(sendblue.rosterAt!({})).toBeNull();
    expect(sendblue.rosterAt!(null)).toBeNull();
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

  it("encodes thread ids exactly as the Sendblue adapter does before it loads", () => {
    const sdk = SendblueAdapter.prototype;
    const direct = { fromNumber: "+15550009999", contactNumber: "+15551234567" };
    const group = { fromNumber: "+15550009999", groupId: "group-1" };
    expect(sendblue.directThreadId!(direct.contactNumber)).toBe(sdk.encodeThreadId(direct));
    for (const data of [direct, group]) {
      const threadId = sdk.encodeThreadId(data);
      expect(sendblue.adapter.encodeThreadId(data)).toBe(threadId);
      expect(sendblue.adapter.decodeThreadId(threadId)).toEqual(sdk.decodeThreadId(threadId));
    }
    expect(sendblue.adapter.isDM?.(sdk.encodeThreadId(group))).toBe(false);
  });
});

describe("parseSendblueStatuses", () => {
  const statusPayload = {
    content: "",
    is_outbound: true,
    status: "DELIVERED",
    message_handle: "handle-1",
    from_number: "+15550009999",
  };

  it("normalizes outbound delivery webhooks", () => {
    expect(parseSendblueStatuses(statusPayload)).toEqual([
      { type: "status", provider: "sendblue", handle: "handle-1", status: "DELIVERED" },
    ]);
    expect(parseSendblueStatuses({ ...statusPayload, status: 7 })).toEqual([
      expect.objectContaining({ status: "" }),
    ]);
  });

  it("ignores inbound and malformed payloads", () => {
    expect(parseSendblueStatuses({ ...statusPayload, is_outbound: false })).toEqual([]);
    expect(parseSendblueStatuses({ ...statusPayload, message_handle: "" })).toEqual([]);
    const { message_handle: _dropped, ...withoutHandle } = statusPayload;
    expect(parseSendblueStatuses(withoutHandle)).toEqual([]);
    expect(parseSendblueStatuses(null)).toEqual([]);
    expect(parseSendblueStatuses("nope")).toEqual([]);
  });
});

describe("WhatsApp file sizes", () => {
  const whatsapp = (env: MessagingEnvironmentValues = fullEnv) =>
    messagingPlatformsFromEnv(env).find((platform) => platform.provider === "whatsapp")!;

  it("reads the size WhatsApp reports for a file from its media lookup", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ url: "https://lookaside.example.test/m", file_size: 2048, id: "media-1" }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const signal = new AbortController().signal;
      await expect(
        whatsapp().attachmentSize!({ type: "file", fetchMetadata: { mediaId: "media-1" } }, signal),
      ).resolves.toBe(2048);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/media-1$/);
      expect(init).toEqual({ headers: { authorization: "Bearer wa-token" }, signal });

      // A file with no media id (a shared location) has nothing to look up.
      await expect(whatsapp().attachmentSize!({ type: "file" }, signal)).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("looks the file up at a configured API URL", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ file_size: 5 }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const signal = new AbortController().signal;
      await whatsapp({ ...fullEnv, whatsappApiUrl: "https://graph.example.test" }).attachmentSize!(
        { type: "file", fetchMetadata: { mediaId: "m/1" } },
        signal,
      );
      const url = fetch.mock.calls[0]![0];
      expect(url.startsWith("https://graph.example.test/v")).toBe(true);
      expect(url.endsWith("/m%2F1")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the size unknown when the lookup reports none, and fails when it fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "media-1" }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const attachment = { type: "file" as const, fetchMetadata: { mediaId: "media-1" } };
      const signal = new AbortController().signal;
      await expect(whatsapp().attachmentSize!(attachment, signal)).resolves.toBeUndefined();
      await expect(whatsapp().attachmentSize!(attachment, signal)).rejects.toThrow("404");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("parseWhatsAppStatuses", () => {
  // Shape of Meta's `statuses` webhook (Cloud API), including a 24-hour-window failure.
  const webhook = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "wa-phone-id" },
              statuses: [
                { id: "wamid.sent", status: "delivered", timestamp: "1", recipient_id: "1555" },
                {
                  id: "wamid.late",
                  status: "failed",
                  timestamp: "2",
                  recipient_id: "1555",
                  errors: [{ code: 131047, title: "Re-engagement message" }],
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it("maps every status in the batch onto the outbox status flow", () => {
    expect(parseWhatsAppStatuses(webhook)).toEqual([
      { type: "status", provider: "whatsapp", handle: "wamid.sent", status: "DELIVERED" },
      { type: "status", provider: "whatsapp", handle: "wamid.late", status: "FAILED" },
    ]);
  });

  it("ignores inbound messages and malformed payloads", () => {
    const inbound = structuredClone(webhook);
    const value = inbound.entry[0]!.changes[0]!.value as Record<string, unknown>;
    delete value.statuses;
    value.messages = [{ id: "wamid.in", from: "1555", type: "text", text: { body: "hi" } }];
    expect(parseWhatsAppStatuses(inbound)).toEqual([]);
    expect(
      parseWhatsAppStatuses({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }),
    ).toEqual([]);
    expect(parseWhatsAppStatuses(null)).toEqual([]);
    expect(parseWhatsAppStatuses({ entry: "nope" })).toEqual([]);
  });
});

describe("splitOutboundBody", () => {
  // The facts live on the mounted platform, so a named bot inherits its adapter's limits.
  const mounted = Object.fromEntries(
    messagingPlatformsFromEnv({
      ...fullEnv,
      telegramBots: [{ name: "work", botToken: "tg-work", webhookSecret: "tg-work-secret" }],
    }).map((platform) => [platform.provider, platform]),
  );

  it.each(["telegram", "telegram-work"])(
    "splits %s replies on paragraph boundaries",
    (provider) => {
      const outbound = mounted[provider]?.outbound;
      const paragraph = "a".repeat(3000);
      expect(splitOutboundBody(outbound, `${paragraph}\n\n${paragraph}`)).toEqual([
        paragraph,
        paragraph,
      ]);
      expect(splitOutboundBody(outbound, "short")).toEqual(["short"]);
      expect(splitOutboundBody(outbound, "a".repeat(4096))).toEqual(["a".repeat(4096)]);
    },
  );

  it.each([
    "a".repeat(4097),
    `${"a".repeat(4095)}😀${"b".repeat(4096)}`,
    "😀".repeat(4097),
    "!".repeat(4096),
  ])("preserves the full text without breaking UTF-16 pairs", (body) => {
    const parts = splitOutboundBody(telegramOutbound, body);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(body);
    expect(parts.every((part) => part.length <= 4096 && !/[\uD800-\uDFFF]/u.test(part))).toBe(true);
  });

  it.each([
    ["a run of emoji one unit off the boundary", `a${"😀".repeat(6000)}`],
    ["an emoji across the first cut", `${"a".repeat(4095)}😀${"b".repeat(4096)}`],
  ])("keeps emoji whole in WhatsApp parts: %s", (_name, body) => {
    const parts = splitOutboundBody(whatsappOutbound, body);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(body);
    expect(parts.every((part) => part.length <= 4096 && !/[\uD800-\uDFFF]/u.test(part))).toBe(true);
  });

  it("splits Slack replies at its 12,000-character Markdown limit", () => {
    const paragraph = "a".repeat(8000);
    expect(splitOutboundBody(slackOutbound, `${paragraph}\n\n${paragraph}`)).toEqual([
      paragraph,
      paragraph,
    ]);
    const mid = "b".repeat(5000);
    expect(splitOutboundBody(slackOutbound, `${mid}\n\n${mid}`)).toEqual([`${mid}\n\n${mid}`]);
    expect(splitOutboundBody(slackOutbound, "short")).toEqual(["short"]);
  });

  it("leaves room for the user ids Slack writes in place of @names", () => {
    const line = "@ab ".repeat(2500);
    const parts = splitOutboundBody(slackOutbound, line);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => slackPayloads(part)[0]!.length <= SLACK_MARKDOWN_LIMIT)).toBe(
      true,
    );
  });

  it("splits WhatsApp replies between paragraphs and leaves a platform without a splitter whole", () => {
    const long = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    expect(splitOutboundBody(whatsappOutbound, long)).toEqual(["a".repeat(3000), "b".repeat(3000)]);
    expect(splitOutboundBody(whatsappOutbound, "short")).toEqual(["short"]);
    // Sendblue declares no limits: it sends the body as one message.
    expect(mounted.sendblue?.outbound).toBeUndefined();
    expect(splitOutboundBody(mounted.sendblue?.outbound, long)).toEqual([long]);
  });
});

describe("permanent send errors", () => {
  const platforms = Object.fromEntries(
    messagingPlatformsFromEnv(fullEnv).map((platform) => [platform.provider, platform]),
  );
  const slackError = (error: string) =>
    Object.assign(new Error(`An API error occurred: ${error}`), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error },
    });
  const permissionError = Object.assign(new Error("telegram sendMessage"), {
    name: "PermissionError",
  });
  const whatsappError = (code: number) =>
    new WhatsAppApiError(
      "WhatsApp API error",
      400,
      JSON.stringify({ error: { code, message: "failed", type: "OAuthException" } }),
    );
  const oversizeImage = (() => {
    try {
      validateFileSize("image", 6 * 1024 * 1024);
    } catch (error) {
      return error;
    }
    throw new Error("expected the adapter to refuse a 6 MB image");
  })();

  it.each([
    ["slack", slackError("channel_not_found"), true],
    ["slack", slackError("not_in_channel"), true],
    ["slack", slackError("invalid_auth"), true],
    ["slack", slackError("internal_error"), false],
    ["slack", new Error("socket hang up"), false],
    ["telegram", permissionError, true],
    ["telegram", new Error("Network error calling Telegram sendMessage"), false],
    ["whatsapp", whatsappError(131047), true],
    ["whatsapp", whatsappError(130429), false],
    ["whatsapp", oversizeImage, true],
    ["whatsapp", new Error("fetch failed"), false],
  ] as const)("%s: %s is permanent=%s", (provider, error, permanent) => {
    expect(platforms[provider]!.isPermanentSendError!(error)).toBe(permanent);
  });

  it("treats no Sendblue error as permanent", () => {
    expect(platforms.sendblue!.isPermanentSendError).toBeUndefined();
  });
});

describe("sendblue client", () => {
  const context: AdapterContext = {
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "ws-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  function sendThrough(apiUrl: string | undefined, status: number) {
    const requests: Array<Record<string, unknown>> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return status === 200
        ? Response.json({ message_handle: "handle-1", status: "QUEUED" })
        : Response.json({ status: "ERROR" }, { status });
    };
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv(
        {
          inboundOrigin: apiUrl,
          sendblueApiKeyId: fullEnv.sendblueApiKeyId,
          sendblueApiSecret: fullEnv.sendblueApiSecret,
          sendblueSigningSecret: fullEnv.sendblueSigningSecret,
          sendbluePhoneNumber: fullEnv.sendbluePhoneNumber,
        },
        { sendblueTransport: { baseURL: "https://api.sendblue.com", fetch } },
      ),
    );
    const sent = surface
      .openDirectThread("sendblue", "+15551234567", context)
      .then((threadId) => surface.sendToThread({ threadId, body: "hi" }, context));
    return { requests, sent };
  }

  it("asks Sendblue to call the public status webhook", async () => {
    const { requests, sent } = sendThrough("https://app.example.test", 200);
    await expect(sent).resolves.toEqual({ handle: "handle-1" });
    expect(requests).toEqual([
      expect.objectContaining({
        status_callback: "https://app.example.test/api/v1/messaging/webhook/sendblue",
      }),
    ]);
  });

  it("requests no status callback without a public HTTPS origin", async () => {
    const { requests, sent } = sendThrough("http://127.0.0.1:3100", 200);
    await sent;
    expect(requests[0]).not.toHaveProperty("status_callback");
  });

  it.each([500, 429, 408])("leaves retries to the outbox on HTTP %s", async (status) => {
    const { requests, sent } = sendThrough(undefined, status);
    await expect(sent).rejects.toMatchObject({ name: "MessagingSendError", permanent: false });
    expect(requests).toHaveLength(1);
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
