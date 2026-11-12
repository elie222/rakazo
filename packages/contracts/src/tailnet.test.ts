import { describe, expect, it } from "vitest";
import {
  parseTailnetDestination,
  TailscaleConnectionConfigSchema,
  tailnetAttributeValue,
  tailnetDestinationKey,
  tailnetNodeAttributes,
  tailnetNodeHostname,
} from "./tailnet.js";

describe("tailnet connection config", () => {
  it("defaults the tag and normalizes its case", () => {
    expect(TailscaleConnectionConfigSchema.parse({ clientId: "id", clientSecret: "s" }).tag).toBe(
      "tag:rakazo",
    );
    expect(
      TailscaleConnectionConfigSchema.parse({ clientId: "id", clientSecret: "s", tag: "Tag:Bots" })
        .tag,
    ).toBe("tag:bots");
  });

  it.each(["rakazo", "tag:", "tag:-bots", "tag:bots!", "tag:a b"])("refuses the tag %s", (tag) => {
    expect(
      TailscaleConnectionConfigSchema.safeParse({ clientId: "id", clientSecret: "s", tag }).success,
    ).toBe(false);
  });
});

describe("tailnet destinations", () => {
  it("normalizes a MagicDNS name and keys IPv6 with brackets", () => {
    expect(parseTailnetDestination("NAS.tail1234.ts.net.", "443")).toEqual({
      host: "nas.tail1234.ts.net",
      port: 443,
    });
    const v6 = parseTailnetDestination("[fd7a:115c:a1e0:ab12::1]", 22);
    expect(v6 && tailnetDestinationKey(v6)).toBe("[fd7a:115c:a1e0:ab12::1]:22");
  });

  it.each([
    ["nas.tail1234.ts.net", 0],
    ["nas.tail1234.ts.net", 65536],
    ["nas.tail1234.ts.net", "22a"],
    ["nas.tail1234.ts.net", "1e3"],
    ["example.com", 443],
    ["100.100.100.100", 53],
    ["fd7a:115c:a1e0:ab12::1%eth0", 22],
  ] as const)("refuses %s:%s", (host, port) => {
    expect(parseTailnetDestination(host, port)).toBeUndefined();
  });
});

describe("tailnet node hostname", () => {
  it("is one DNS label naming the bot", () => {
    expect(tailnetNodeHostname({ name: "Home Lab Helper", id: "cm9x2k7q0000abc123" })).toBe(
      "rakazo-home-lab-helper-abc123",
    );
    expect(tailnetNodeHostname({ name: "Café ✨", id: "B_1" })).toBe("rakazo-cafe-b1");
    expect(tailnetNodeHostname({ name: "🤖", id: "bot1" })).toBe("rakazo-bot1");
    const long = tailnetNodeHostname({ name: "x".repeat(100), id: "z".repeat(30) });
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("tailnet node attributes", () => {
  it("keeps values within Tailscale's character set and length", () => {
    expect(tailnetAttributeValue("user@example.test")).toBe("user_example.test");
    expect(tailnetAttributeValue("x".repeat(80))).toHaveLength(50);
    expect(tailnetNodeAttributes({ spaceId: "sp1", botId: "bot-1", userId: "u1" })).toEqual({
      "custom:rakazoSpace": "sp1",
      "custom:rakazoBot": "bot_1",
      "custom:rakazoUser": "u1",
    });
  });
});
