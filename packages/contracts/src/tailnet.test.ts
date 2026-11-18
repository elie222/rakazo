import { describe, expect, it } from "vitest";
import {
  parseNetworkDestination,
  TailnetConnectionConfigSchema,
  tailnetAttributeValue,
  tailnetDestinationKey,
  tailnetNodeAttributes,
  tailnetNodeHostname,
} from "./tailnet.js";
import { expectLinearTime } from "./testing/timing.test-support.js";

describe("tailnet connection config", () => {
  it("defaults the tag and normalizes its case", () => {
    expect(TailnetConnectionConfigSchema.parse({ clientId: "id", clientSecret: "s" }).tag).toBe(
      "tag:rakazo",
    );
    expect(
      TailnetConnectionConfigSchema.parse({ clientId: "id", clientSecret: "s", tag: "Tag:Bots" })
        .tag,
    ).toBe("tag:bots");
  });

  it.each(["rakazo", "tag:", "tag:-bots", "tag:bots!", "tag:a b"])("refuses the tag %s", (tag) => {
    expect(
      TailnetConnectionConfigSchema.safeParse({ clientId: "id", clientSecret: "s", tag }).success,
    ).toBe(false);
  });
});

describe("network destinations", () => {
  it("normalizes a name and keys IPv6 with brackets", () => {
    expect(parseNetworkDestination("NAS.tail1234.ts.net.", "443")).toEqual({
      host: "nas.tail1234.ts.net",
      port: 443,
    });
    const v6 = parseNetworkDestination("[fd7a:115c:a1e0:ab12::1]", 22);
    expect(v6 && tailnetDestinationKey(v6)).toBe("[fd7a:115c:a1e0:ab12::1]:22");
  });

  it.each([
    ["nas.tail1234.ts.net", 0],
    ["nas.tail1234.ts.net", 65536],
    ["nas.tail1234.ts.net", "22a"],
    ["nas.tail1234.ts.net", "1e3"],
    ["", 22],
    ["nas tail", 22],
    ["fd7a:115c:a1e0:ab12::1%eth0", 22],
  ] as const)("refuses %s:%s", (host, port) => {
    expect(parseNetworkDestination(host, port)).toBeUndefined();
  });
});

describe("tailnetNodeHostname", () => {
  it("slugs the bot name and keeps an id suffix", () => {
    expect(tailnetNodeHostname({ name: "Helper Bot", id: "bot-abc123" })).toBe(
      "rakazo-helper-bot-abc123",
    );
    expect(tailnetNodeHostname({ name: "---Wow!!!---", id: "x" })).toBe("rakazo-wow-x");
    expect(tailnetNodeHostname({ name: `${"a".repeat(50)}-tail`, id: "id9999" })).toBe(
      `rakazo-${"a".repeat(40)}-id9999`,
    );
  });

  it("stays fast on a long name full of hyphens", () => {
    expectLinearTime(() =>
      expect(tailnetNodeHostname({ name: "-".repeat(200_000), id: "bot1" })).toBe("rakazo-bot1"),
    );
  });
});

describe("tailnet node attributes", () => {
  it("sanitizes posture values", () => {
    expect(tailnetAttributeValue("space/1!")).toBe("space_1_");
    expect(tailnetNodeAttributes({ spaceId: "home", botId: "helper", userId: "alice" })).toEqual({
      "custom:rakazoSpace": "home",
      "custom:rakazoBot": "helper",
      "custom:rakazoUser": "alice",
    });
  });
});
