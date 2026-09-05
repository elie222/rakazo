import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { MessagingOutboundStatus } from "@rakazo/adapter-kit";
import type { Adapter } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { isVitestRuntime } from "./test-runtime.js";

/**
 * Parsed platform credentials, filled from process.env at the composition
 * roots. A platform mounts when its full credential set is present.
 */
export interface MessagingEnvironmentValues {
  sendblueApiKeyId?: string | undefined;
  sendblueApiSecret?: string | undefined;
  sendblueSigningSecret?: string | undefined;
  sendbluePhoneNumber?: string | undefined;
  slackBotToken?: string | undefined;
  slackSigningSecret?: string | undefined;
  whatsappAccessToken?: string | undefined;
  whatsappPhoneNumberId?: string | undefined;
  whatsappAppSecret?: string | undefined;
  whatsappVerifyToken?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramWebhookSecret?: string | undefined;
}

export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  // Same trim/empty-to-undefined normalization the API's env loader applies,
  // so a credential with stray whitespace behaves identically in both roles.
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return {
    sendblueApiKeyId: clean(env.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: clean(env.SENDBLUE_API_SECRET),
    sendblueSigningSecret: clean(env.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: clean(env.SENDBLUE_PHONE_NUMBER),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackSigningSecret: clean(env.SLACK_SIGNING_SECRET),
    whatsappAccessToken: clean(env.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: clean(env.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: clean(env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET_TOKEN),
  };
}

/**
 * Build the platform list for every fully configured provider. Group
 * conversations stay sendblue-only until channel semantics are mapped for
 * the other platforms, so their capabilities say so instead of half-working.
 */
export function messagingPlatformsFromEnv(env: MessagingEnvironmentValues): MessagingPlatform[] {
  const platforms: MessagingPlatform[] = [];

  if (
    env.sendblueApiKeyId &&
    env.sendblueApiSecret &&
    env.sendblueSigningSecret &&
    env.sendbluePhoneNumber
  ) {
    const lineNumber = env.sendbluePhoneNumber;
    const adapter = createSendblueAdapter({
      apiKey: env.sendblueApiKeyId,
      apiSecret: env.sendblueApiSecret,
      defaultFromNumber: lineNumber,
      webhookSecret: env.sendblueSigningSecret,
      allowedServices: ["iMessage", "SMS", "RCS"],
    });
    // chat@4.39 derives thread.isDM solely from the optional Adapter.isDM
    // hook, and chat-adapter-sendblue@0.2.0 omits it — without this every
    // 1:1 message would route as a group. Derive it from the thread id.
    Object.assign(adapter, {
      isDM: (threadId: string) => !adapter.decodeThreadId(threadId).groupId,
    } satisfies Pick<Adapter, "isDM">);
    platforms.push({
      provider: "sendblue",
      capabilities: { direct: true, groups: true, typing: true },
      adapter,
      directThreadId: (address) =>
        adapter.encodeThreadId({ fromNumber: lineNumber, contactNumber: address }),
      peekStatus: (payload) => parseSendblueStatus(payload),
      participants: (raw) => sendblueParticipants(raw, lineNumber),
      channelName: (raw) => sendblueGroupName(raw),
    });
  }

  if (env.slackBotToken && env.slackSigningSecret) {
    platforms.push({
      provider: "slack",
      capabilities: { direct: true, groups: false, typing: false },
      adapter: createSlackAdapter({
        botToken: env.slackBotToken,
        signingSecret: env.slackSigningSecret,
      }),
    });
  }

  if (
    env.whatsappAccessToken &&
    env.whatsappPhoneNumberId &&
    env.whatsappAppSecret &&
    env.whatsappVerifyToken
  ) {
    platforms.push({
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, typing: false },
      adapter: createWhatsAppAdapter({
        accessToken: env.whatsappAccessToken,
        phoneNumberId: env.whatsappPhoneNumberId,
        appSecret: env.whatsappAppSecret,
        verifyToken: env.whatsappVerifyToken,
      }),
    });
  }

  // Both required: without the secret token the adapter accepts unsigned
  // webhook posts, so a forged update could reach inbound processing.
  if (env.telegramBotToken && env.telegramWebhookSecret) {
    platforms.push({
      provider: "telegram",
      capabilities: { direct: true, groups: false, typing: false },
      // Webhook-only: auto mode can long-poll getUpdates from the worker on
      // initialize() and consume updates so the HTTP webhook never sees them.
      adapter: createTelegramAdapter({
        botToken: env.telegramBotToken,
        secretToken: env.telegramWebhookSecret,
        mode: "webhook",
      }),
    });
  }

  return platforms;
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}

/**
 * Linked users run on their own credentials, so linking-only deployments
 * need no deployment key. Open signup provisions users with no credential
 * of their own, so that mode requires the deployment model key — without
 * it their runs cannot execute.
 */
export function isMessagingSurfaceEnabled(
  platforms: MessagingPlatform[],
  options: { deploymentModelKey: string | undefined; openSignup: boolean },
): boolean {
  if (!isMessagingEnabled(platforms)) return false;
  return options.openSignup ? Boolean(options.deploymentModelKey) : true;
}

/** Sendblue reports outbound delivery as webhooks the Chat SDK ignores. */
export function parseSendblueStatus(payload: unknown): MessagingOutboundStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.is_outbound !== true) return null;
  if (typeof body.message_handle !== "string" || !body.message_handle) return null;
  return {
    type: "status",
    provider: "sendblue",
    handle: body.message_handle,
    status: typeof body.status === "string" ? body.status : "",
  };
}

function sendblueParticipants(raw: unknown, lineNumber: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const participants = (raw as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return [];
  return participants.filter(
    (entry): entry is string => typeof entry === "string" && entry !== lineNumber,
  );
}

function sendblueGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as { group_display_name?: unknown }).group_display_name;
  return typeof name === "string" && name ? name : null;
}
