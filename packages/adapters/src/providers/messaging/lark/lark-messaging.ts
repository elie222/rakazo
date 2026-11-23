import { defineMessagingPlatform } from "../../../messaging/messaging-platform-descriptor.js";
import { LazyLarkAdapter } from "./lazy-adapter.js";
import { Domain } from "./thread-id.js";

/** Unset or blank is Feishu. Any other value must be feishu or lark, or startup fails. */
function larkDomain(setting: string | undefined): Domain {
  const value = setting?.trim().toLowerCase();
  if (!value || value === "feishu") return Domain.Feishu;
  if (value === "lark") return Domain.Lark;
  throw new Error("LARK_DOMAIN must be feishu or lark");
}

/**
 * App ID, secret, and verification token are all required: without the token the adapter
 * accepts unsigned webhook posts. Encrypt key and domain are optional (event encryption /
 * open.feishu.cn vs open.larksuite.com).
 */
export const larkMessaging = defineMessagingPlatform({
  env: {
    larkAppId: { name: "LARK_APP_ID", required: true },
    larkAppSecret: { name: "LARK_APP_SECRET", required: true },
    larkVerificationToken: { name: "LARK_VERIFICATION_TOKEN", required: true },
    larkEncryptKey: { name: "LARK_ENCRYPT_KEY" },
    larkDomain: { name: "LARK_DOMAIN" },
  },
  mount(env, options) {
    // Webhook-only: ws/long-connection incoming would consume events so
    // the HTTP webhook at /api/v1/messaging/webhook/lark never sees them.
    const adapter = new LazyLarkAdapter({
      ...(options.larkTransport ? { httpInstance: options.larkTransport } : {}),
      appId: env.larkAppId,
      appSecret: env.larkAppSecret,
      verificationToken: env.larkVerificationToken,
      // Explicit defaults prevent the adapter from rereading untrimmed process.env values.
      encryptKey: env.larkEncryptKey ?? "",
      domain: larkDomain(env.larkDomain),
    });
    return {
      provider: "lark",
      capabilities: { direct: true, groups: false, receipt: null },
      adapter,
      postOnce: (threadId, message, idempotencyKey) =>
        adapter.postMessage(threadId, message, idempotencyKey),
    };
  },
});
