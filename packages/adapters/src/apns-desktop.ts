import { randomUUID } from "node:crypto";
import type { NotificationMessage } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ApnsConfig, ApnsTransport } from "./apns-http.js";
import { ApnsAuthorization, apnsOrigin, apnsTransport } from "./apns-http.js";
import { capped, expoPushData } from "./expo-push.js";

/** Notifications for the desktop app while it is closed; open apps show the server's alerts. */
export interface DesktopPushProvider {
  send(
    token: string,
    message: NotificationMessage,
    spaceId: string,
  ): Promise<"sent" | "invalid" | "failed">;
}

const MAX_TITLE_CHARS = 100;
const MAX_BODY_CHARS = 180;

export class ApnsDesktopProvider implements DesktopPushProvider {
  private readonly authorization;
  constructor(
    private readonly config: ApnsConfig,
    private readonly transport: ApnsTransport = apnsTransport,
  ) {
    this.authorization = new ApnsAuthorization(config);
  }

  async send(
    token: string,
    message: NotificationMessage,
    spaceId: string,
  ): Promise<"sent" | "invalid" | "failed"> {
    const urgent =
      message.kind === "help" || message.kind === "takeover" || message.kind === "failure";
    try {
      const reply = await this.transport(
        apnsOrigin(this.config.environment),
        {
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: this.authorization.header(),
          "apns-topic": this.config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": urgent ? "10" : "5",
          // A newer alert for the same chat replaces the one still in Notification Center.
          "apns-collapse-id": message.threadId.slice(0, 64),
          "content-type": "application/json",
        },
        JSON.stringify({
          aps: {
            alert: {
              title: capped(message.title, MAX_TITLE_CHARS),
              body: capped(message.body, MAX_BODY_CHARS),
            },
            sound: "default",
            "thread-id": message.groupId ?? message.threadId,
            ...(message.badge === undefined ? {} : { badge: message.badge }),
          },
          // Without the sender's picture: the dock icon already says which app it is.
          ...expoPushData({ ...message, sender: undefined }, spaceId, randomUUID()),
        }),
      );
      if (reply.status === 410 || reply.reason === "Unregistered") return "invalid";
      if (reply.status === 200) return "sent";
      // BadDeviceToken also means a sandbox/production mismatch, so it never drops the token.
      getLogger().warn("desktop.push_failed", { status: reply.status, reason: reply.reason });
      return "failed";
    } catch (error) {
      getLogger().warn("desktop.push_failed", { error });
      return "failed";
    }
  }
}
