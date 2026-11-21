import { describe, expect, it } from "vitest";
import { sendToChatChange } from "./routine-draft.js";

describe("sendToChatChange", () => {
  it("sends the switch only when the draft changes it", () => {
    expect(sendToChatChange({ sendToChat: true }, { sendToChat: false })).toEqual({
      sendToChat: true,
    });
    expect(sendToChatChange({ sendToChat: false }, { sendToChat: true })).toEqual({
      sendToChat: false,
    });
    expect(sendToChatChange({ sendToChat: true }, { sendToChat: true })).toEqual({});
    expect(sendToChatChange({ sendToChat: false }, { sendToChat: false })).toEqual({});
  });
});
