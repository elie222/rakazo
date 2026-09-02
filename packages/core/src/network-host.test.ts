import { describe, expect, it } from "vitest";
import {
  allowsCleartextHttp,
  isLinkLocalHost,
  isLoopbackHost,
  isTailscaleMagicDnsHost,
  unbracketedHost,
} from "./network-host.js";

describe("network host policy", () => {
  it("normalizes IPv6 brackets", () => {
    expect(unbracketedHost("[fd00::1]")).toBe("fd00::1");
    expect(unbracketedHost("LOCALHOST")).toBe("localhost");
  });

  it("detects loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("dev.localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("detects link-local metadata ranges", () => {
    expect(isLinkLocalHost("169.254.169.254")).toBe(true);
    expect(isLinkLocalHost("169.254.1.1")).toBe(true);
    expect(isLinkLocalHost("[fe80::1]")).toBe(true);
    expect(isLinkLocalHost("fe80::1")).toBe(true);
    expect(isLinkLocalHost("fe80.example.com")).toBe(false);
    expect(isLinkLocalHost("10.0.0.1")).toBe(false);
  });

  it("detects Tailscale MagicDNS names", () => {
    expect(isTailscaleMagicDnsHost("machine.ts.net")).toBe(true);
    expect(isTailscaleMagicDnsHost("box.tail12345.ts.net")).toBe(true);
    expect(isTailscaleMagicDnsHost("ts.net")).toBe(true);
    expect(isTailscaleMagicDnsHost("notts.net")).toBe(false);
    expect(isTailscaleMagicDnsHost("example.com")).toBe(false);
  });

  it("allows cleartext HTTP on LAN, loopback, CGNAT, ULA, and .local", () => {
    expect(allowsCleartextHttp("127.0.0.1")).toBe(true);
    expect(allowsCleartextHttp("10.0.0.8")).toBe(true);
    expect(allowsCleartextHttp("192.168.1.20")).toBe(true);
    expect(allowsCleartextHttp("172.16.0.2")).toBe(true);
    expect(allowsCleartextHttp("100.64.0.1")).toBe(true);
    expect(allowsCleartextHttp("100.119.57.55")).toBe(true);
    expect(allowsCleartextHttp("rakazo.local")).toBe(true);
    expect(allowsCleartextHttp("[fd00::1]")).toBe(true);
    expect(allowsCleartextHttp("fc00::2")).toBe(true);
  });

  it("rejects cleartext HTTP to public DNS, MagicDNS, and link-local", () => {
    expect(allowsCleartextHttp("app.example.com")).toBe(false);
    expect(allowsCleartextHttp("fd.example.com")).toBe(false);
    expect(allowsCleartextHttp("fc.evil.com")).toBe(false);
    expect(allowsCleartextHttp("fc-host.example.com")).toBe(false);
    expect(allowsCleartextHttp("machine.ts.net")).toBe(false);
    expect(allowsCleartextHttp("169.254.169.254")).toBe(false);
    expect(allowsCleartextHttp("[fe80::1]")).toBe(false);
    expect(allowsCleartextHttp("8.8.8.8")).toBe(false);
  });
});
