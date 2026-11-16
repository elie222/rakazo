import { describe, expect, it } from "vitest";
import {
  CLOUD_AGENT_OPEN_PR,
  cloudAgentWakePrompt,
  mediaVideoWakePrompt,
  purchaseWakePrompt,
  ticketWakePrompt,
} from "./wakes.prompt.js";

describe("wake prompts", () => {
  it("renders each wake as the bot reads it", () => {
    expect(ticketWakePrompt("OPS-7")).toMatchInlineSnapshot(
      `"Work on ticket OPS-7. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed."`,
    );
    expect(purchaseWakePrompt("purchase-1", "approved")).toMatchInlineSnapshot(
      `"Purchase purchase-1 is approved. Use purchase_status to continue."`,
    );
    expect(mediaVideoWakePrompt("job-1", true)).toMatchInlineSnapshot(
      `"Video job job-1 finished and is attached to the chat."`,
    );
    expect(mediaVideoWakePrompt("job-1", false)).toMatchInlineSnapshot(
      `"Video job job-1 failed. Do not resubmit unless the user asks."`,
    );
    expect(cloudAgentWakePrompt("agent-1", "completed")).toMatchInlineSnapshot(
      `"Cloud agent agent-1 is completed. Use cloud_agent_status to inspect its result."`,
    );
    expect(CLOUD_AGENT_OPEN_PR).toMatchInlineSnapshot(
      `"When you finish, open a pull request with your changes."`,
    );
  });
});
