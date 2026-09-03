import { describe, expect, it } from "vitest";
import { isLinkLocalAddress, isPrivateAddress } from "./network-address.js";

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

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::10.1.2.3",
    "2002:a9fe:a9fe::1",
    "2002:0a01:0203::",
    "2002:c0a8:0001::1",
  ])("classifies %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "203.0.113.10",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "64:ff9b::cb00:7101",
    "64:ff9b::203.0.113.10",
    "2002:cb00:7101::1",
    "::ffff:203.0.113.10",
  ])("classifies %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
