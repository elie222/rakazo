import { randomUUID } from "node:crypto";
import type { NotificationMessage } from "@rakazo/adapter-kit";
import type { ApnsTransport, ApnsVoipConfig } from "./apns-voip.js";
import { ApnsClient } from "./apns-voip.js";
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
  private readonly client: ApnsClient;
  constructor(config: ApnsVoipConfig, transport?: ApnsTransport) {
    this.client = new ApnsClient(config, transport);
  }

  async send(
    token: string,
    message: NotificationMessage,
    spaceId: string,
  ): Promise<"sent" | "invalid" | "failed"> {
    const urgent =
      message.kind === "help" || message.kind === "takeover" || message.kind === "failure";
    const result = await this.client.send(
      token,
      {
        topic: this.client.config.bundleId,
        pushType: "alert",
        priority: urgent ? 10 : 5,
        // A newer alert for the same chat replaces the one still in Notification Center.
        collapseId: message.threadId.slice(0, 64),
        body: {
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
        },
      },
      "desktop.push_failed",
    );
    return result === "unavailable" ? "failed" : result;
  }
}
