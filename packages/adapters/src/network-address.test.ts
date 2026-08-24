import { describe, expect, it } from "vitest";
import { isLinkLocalAddress } from "./network-address.js";

describe("network address classification", () => {
  it.each([
    "169.254.1.1",
    "fe80::1",
    "::169.254.1.1",
    "::ffff:169.254.1.1",
    "::a9fe:101",
    "::ffff:a9fe:101",
  ])("classifies %s as link-local", (address) => {
    expect(isLinkLocalAddress(address)).toBe(true);
  });

  it.each(["127.0.0.1", "192.168.1.1", "::1", "fd00::1", "203.0.113.1"])(
    "does not classify %s as link-local",
    (address) => {
      expect(isLinkLocalAddress(address)).toBe(false);
    },
  );
});
