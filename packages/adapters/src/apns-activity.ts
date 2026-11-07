import { getLogger } from "@rakazo/logging";
import type { ApnsTransport, ApnsVoipConfig } from "./apns-voip.js";
import { ApnsClient } from "./apns-voip.js";
import type { WorkActivityPush, WorkActivityPushProvider } from "./work-activity.js";

/** A step update that never arrives is replaced by the next; give each a few minutes. */
const UPDATE_LIFETIME_SECONDS = 5 * 60;

/** Updates and ends the iOS Live Activity the app starts for the user's bots at work. */
export class ApnsActivityProvider implements WorkActivityPushProvider {
  private readonly client: ApnsClient;
  constructor(config: ApnsVoipConfig, transport?: ApnsTransport) {
    this.client = new ApnsClient(config, transport);
  }
  async send(token: string, push: WorkActivityPush): Promise<"sent" | "invalid" | "unavailable"> {
    try {
      const reply = await this.client.post(token, {
        topic: `${this.client.config.bundleId}.push-type.liveactivity`,
        pushType: "liveactivity",
        // Steps change often and iOS budgets high priority updates.
        priority: push.urgent ? 10 : 5,
        expiration: push.at + UPDATE_LIFETIME_SECONDS,
        body: {
          aps: {
            timestamp: push.at,
            event: push.ended ? "end" : "update",
            "content-state": push.state,
            // The reply arrives as its own notification, so the card leaves straight away.
            ...(push.ended ? { "dismissal-date": push.at } : {}),
          },
        },
      });
      if (reply.status === 410 || reply.reason === "Unregistered") return "invalid";
      if (reply.status === 200) return "sent";
      getLogger().warn("thread_activity.push_failed", {
        status: reply.status,
        reason: reply.reason,
      });
      // BadDeviceToken also means a sandbox/production mismatch, so it never drops the card.
      return "unavailable";
    } catch (error) {
      getLogger().warn("thread_activity.push_failed", { error });
      return "unavailable";
    }
  }
}
