import { describe, expect, it } from "vitest";
import {
  connectionHintForOrigin,
  connectionKindForHost,
  describeConnectionOrigin,
} from "./connection-kind.js";

describe("connection kind", () => {
  it("classifies loopback, LAN, overlay, and public hosts", () => {
    expect(connectionKindForHost("127.0.0.1")).toBe("loopback");
    expect(connectionKindForHost("localhost")).toBe("loopback");
    expect(connectionKindForHost("192.168.1.20")).toBe("lan");
    expect(connectionKindForHost("10.0.0.8")).toBe("lan");
    expect(connectionKindForHost("rakazo.local")).toBe("lan");
    expect(connectionKindForHost("100.64.0.1")).toBe("overlay");
    expect(connectionKindForHost("machine.ts.net")).toBe("overlay");
    expect(connectionKindForHost("app.example.com")).toBe("public");
  });

  it("summarizes an origin for reconnect copy", () => {
    expect(describeConnectionOrigin("https://app.example.com/app")).toBe(
      "app.example.com · https · public",
    );
    expect(describeConnectionOrigin("http://192.168.1.20:3100")).toBe(
      "192.168.1.20:3100 · http · local network",
    );
    expect(describeConnectionOrigin("https://box.tail12345.ts.net")).toBe(
      "box.tail12345.ts.net · https · private overlay",
    );
    expect(describeConnectionOrigin("ftp://files.example.com")).toBeNull();
  });

  it("hints when HTTPS or an overlay client is required", () => {
    expect(connectionHintForOrigin("http://app.example.com")).toBe("Public servers need https://.");
    expect(connectionHintForOrigin("http://machine.ts.net")).toBe("MagicDNS needs https://.");
    expect(connectionHintForOrigin("https://machine.ts.net")).toBe(
      "Join the same Tailscale or EasyTier network as the server.",
    );
    expect(connectionHintForOrigin("http://100.64.0.1:3100")).toBe("Overlay IPs need https://.");
    expect(connectionHintForOrigin("https://100.64.0.1:3100")).toBe(
      "Join the same Tailscale or EasyTier network as the server.",
    );
    expect(connectionHintForOrigin("https://app.example.com")).toBeNull();
    expect(connectionHintForOrigin("http://192.168.1.20:3100")).toBeNull();
  });
});
