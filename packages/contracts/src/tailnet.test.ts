import { describe, expect, it } from "vitest";
import {
  parseNetworkDestination,
  TailnetConnectionConfigSchema,
  tailnetAttributeValue,
  tailnetDestinationKey,
  tailnetNodeAttributes,
  tailnetNodeHostname,
} from "./tailnet.js";

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
