import { expect, it } from "vitest";
import { notificationAttention } from "./notification-attention.js";

it.each([
  ["waiting_input", true, "needs_attention"],
  ["waiting_takeover", false, "needs_attention"],
  ["failed", true, "needs_attention"],
  ["failed", false, null],
  ["running", true, "working"],
  ["queued", false, "working"],
  ["leased", false, "working"],
  ["completed", true, "unread"],
  ["cancelled", false, null],
  ["idle", true, "unread"],
] as const)("classifies %s without confusing work and unread receipts", (status, unread, state) => {
  expect(notificationAttention(status, unread)).toBe(state);
});

it("uses the roster's last failure without masking newly running work", () => {
  expect(notificationAttention("idle", true, true)).toBe("needs_attention");
  expect(notificationAttention("idle", false, true)).toBeNull();
  expect(notificationAttention("running", true, true)).toBe("working");
});
