import { describe, expect, it } from "vitest";
import {
  isTailnetAddress,
  isTailnetHost,
  parseTailnetDestination,
  tailnetConnectSite,
} from "./tailnet-host.js";

describe("tailnet hosts", () => {
  it.each([
    "100.64.0.1",
    "100.101.102.103",
    "100.127.255.254",
    "fd7a:115c:a1e0:ab12::1",
    "[FD7A:115C:A1E0:AB12:4843:CD96:6258:B240]",
  ])("accepts the tailnet address %s", (address) => {
    expect(isTailnetAddress(address)).toBe(true);
    expect(isTailnetHost(address)).toBe(true);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.1",
    "100.100.100.100",
    "100.100.100.200",
    "fd7a:115c:a1e0::53",
    "fd7a:115c:a1e1::1",
    "fd7a:115c:a1e0:ab12::1%eth0",
    "::ffff:100.64.0.1",
    "10.0.0.1",
    "8.8.8.8",
    "nas",
  ])("refuses %s as a tailnet address", (address) => {
    expect(isTailnetAddress(address)).toBe(false);
  });

  it.each(["nas.tail1234.ts.net", "NAS.Tail1234.ts.net.", "db-1.corp-net.ts.net"])(
    "accepts the MagicDNS name %s",
    (host) => {
      expect(isTailnetHost(host)).toBe(true);
    },
  );

  it.each([
    "ts.net",
    "tail1234.ts.net",
    "nas",
    "nas.local",
    "nas.example.com",
    "nas.tail1234.ts.net.evil.test",
    "-nas.tail1234.ts.net",
    "nas_1.tail1234.ts.net",
    "100.100.100.100",
    "10.0.0.1",
  ])("refuses %s as a tailnet host", (host) => {
    expect(isTailnetHost(host)).toBe(false);
  });

  it("parses only tailnet destinations, and names a tailnet_connect call's", () => {
    expect(parseTailnetDestination("NAS.tail1234.ts.net.", "443")).toEqual({
      host: "nas.tail1234.ts.net",
      port: 443,
    });
    expect(parseTailnetDestination("example.com", 443)).toBeUndefined();
    expect(parseTailnetDestination("100.100.100.100", 53)).toBeUndefined();
    expect(tailnetConnectSite({ host: "fd7a:115c:a1e0:ab12::1", port: "22" })).toBe(
      "[fd7a:115c:a1e0:ab12::1]:22",
    );
    expect(tailnetConnectSite({ host: "example.com", port: 22 })).toBeUndefined();
    expect(tailnetConnectSite({ host: "nas.tail1234.ts.net" })).toBeUndefined();
  });
});
