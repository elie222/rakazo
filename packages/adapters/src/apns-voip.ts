import type { IncomingCallNotification as IncomingCallPush } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ApnsConfig, ApnsTransport } from "./apns-http.js";
import { ApnsAuthorization, apnsOrigin, apnsTransport } from "./apns-http.js";

export type { IncomingCallNotification as IncomingCallPush } from "@rakazo/adapter-kit";

export interface VoipPushProvider {
  send(token: string, call: IncomingCallPush): Promise<"sent" | "invalid" | "unavailable">;
}

export type ApnsVoipConfig = ApnsConfig;

export type { ApnsTransport } from "./apns-http.js";

export class ApnsVoipProvider implements VoipPushProvider {
  private readonly authorization;
  constructor(
    private readonly config: ApnsVoipConfig,
    private readonly transport: ApnsTransport = apnsTransport,
  ) {
    this.authorization = new ApnsAuthorization(config);
  }
  async send(token: string, call: IncomingCallPush): Promise<"sent" | "invalid" | "unavailable"> {
    const expiration = Math.floor(Date.parse(call.expiresAt) / 1000);
    if (!(expiration > Date.now() / 1000)) return "unavailable";
    const authorization = this.authorization.header();
    try {
      const reply = await this.transport(
        apnsOrigin(this.config.environment),
        {
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization,
          "apns-topic": `${this.config.bundleId}.voip`,
          "apns-push-type": "voip",
          "apns-priority": "10",
          "apns-expiration": String(expiration),
          "content-type": "application/json",
        },
        JSON.stringify({
          aps: {},
          callId: call.callId,
          botId: call.botId,
          botName: call.botName.slice(0, 100),
          expiresAt: call.expiresAt,
        }),
      );
      if (reply.status === 410 || reply.reason === "Unregistered") return "invalid";
      if (reply.status === 200) return "sent";
      // BadDeviceToken also means a sandbox/production mismatch, so it never drops the token.
      getLogger().warn("call.voip_push_failed", { status: reply.status, reason: reply.reason });
      return "unavailable";
    } catch (error) {
      getLogger().warn("call.voip_push_failed", { error });
      return "unavailable";
    }
  }
}
