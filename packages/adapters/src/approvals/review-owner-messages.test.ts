import { expect, it } from "vitest";
import { reviewOwnerMessages } from "./review-owner-messages.js";

it("keeps the owner's last three earlier messages, oldest first, each capped", () => {
  const long = "x".repeat(500);
  const messages = reviewOwnerMessages(["one", " ", "two", "three", long]);
  expect(messages.slice(0, 2)).toEqual(["two", "three"]);
  expect(messages[2]).toHaveLength(300);
  expect(reviewOwnerMessages([])).toEqual([]);
});
