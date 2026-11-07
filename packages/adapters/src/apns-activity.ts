import type { ApnsTransport, ApnsVoipConfig } from "./apns-voip.js";
import { ApnsClient } from "./apns-voip.js";
import type { WorkActivityPush, WorkActivityPushProvider } from "./work-activity.js";

/** A step update that never arrives is replaced by the next; give each a few minutes. */
const UPDATE_LIFETIME_SECONDS = 5 * 60;
/** iOS removes a Live Activity after 8 hours anyway. */
const ACTIVITY_LIFETIME_SECONDS = 8 * 60 * 60;

/** Updates and ends the iOS Live Activity the app starts for the user's bots at work. */
export class ApnsActivityProvider implements WorkActivityPushProvider {
  private readonly client: ApnsClient;
  constructor(config: ApnsVoipConfig, transport?: ApnsTransport) {
    this.client = new ApnsClient(config, transport);
  }
  send(token: string, push: WorkActivityPush): Promise<"sent" | "invalid" | "unavailable"> {
    return this.client.send(
      token,
      {
        topic: `${this.client.config.bundleId}.push-type.liveactivity`,
        pushType: "liveactivity",
        // Steps change often and iOS budgets high priority updates.
        priority: push.urgent ? 10 : 5,
        // Nothing replaces the end, so Apple keeps it until an offline phone is back.
        expiration: push.at + (push.ended ? ACTIVITY_LIFETIME_SECONDS : UPDATE_LIFETIME_SECONDS),
        body: {
          aps: {
            timestamp: push.at,
            event: push.ended ? "end" : "update",
            "content-state": push.state,
            // The reply arrives as its own notification, so the card leaves straight away.
            ...(push.ended ? { "dismissal-date": push.at } : {}),
          },
        },
      },
      "work_activity.push_failed",
    );
  }
}
