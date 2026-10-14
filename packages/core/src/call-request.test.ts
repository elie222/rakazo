import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { callIdFromClientNonce } from "./call-nonce.js";
import { callRequestClientNonce, ringingCall } from "./call-request.js";

const NOW = Date.parse("2026-10-14T18:30:00Z");

function request(status: string, expiresAt = "2026-10-14T18:30:30Z"): MessageBlock {
  return {
    kind: "call_request",
    callId: `call-${status}`,
    reason: "3 reminders without a reply",
    opening: "You missed my reminders, so I'm calling.",
    status,
    expiresAt,
  } as MessageBlock;
}

describe("call requests", () => {
  it("carries the call id in its nonce, so the transcript groups it with the call", () => {
    expect(callIdFromClientNonce(callRequestClientNonce("abc"))).toBe("abc");
  });

  it("finds the call that is still ringing", () => {
    expect(
      ringingCall(
        [
          { role: "bot", blocks: [{ kind: "text", text: "Third reminder." }] },
          { role: "bot", blocks: [request("ringing")] },
        ],
        NOW,
      ),
    ).toEqual({
      callId: "call-ringing",
      reason: "3 reminders without a reply",
      opening: "You missed my reminders, so I'm calling.",
      expiresAt: "2026-10-14T18:30:30Z",
    });
  });

  it("ignores calls that rang out or already settled", () => {
    expect(
      ringingCall(
        [
          { role: "bot", blocks: [request("ringing", "2026-10-14T18:29:59Z")] },
          { role: "bot", blocks: [request("answered")] },
          { role: "bot", blocks: [request("missed")] },
          { role: "user", blocks: [request("ringing")] },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("includes the spoken opening in answered history", () => {
    expect(blocksToAgentHistoryText([request("answered")])).toContain(
      "You missed my reminders, so I'm calling.",
    );
  });

  it("tells the bot how its call ended", () => {
    expect(blocksToAgentHistoryText([request("missed")])).toBe(
      "[you called the user about: 3 reminders without a reply; the user did not answer]",
    );
  });
});
