import { describe, expect, it } from "vitest";
import { allowsProtectedBrowserAddresses } from "./protected-browser-proxy.js";

describe("protected browser destination policy", () => {
  it("rejects a DNS answer set containing an assigned public IPv4 address", () => {
    expect(
      allowsProtectedBrowserAddresses(
        [
          { address: "93.184.216.35", family: 4 },
          { address: "::ffff:93.184.216.34", family: 6 },
        ],
        {
          fixture: [
            {
              address: "93.184.216.34",
              family: "IPv4",
              netmask: "255.255.255.255",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "93.184.216.34/32",
            },
          ],
        },
      ),
    ).toBe(false);
  });

  it("rejects an assigned public IPv6 address written in a different form", () => {
    expect(
      allowsProtectedBrowserAddresses([{ address: "2001:4860::1", family: 6 }], {
        fixture: [
          {
            address: "2001:4860:0:0:0:0:0:1",
            family: "IPv6",
            netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "2001:4860::1/128",
            scopeid: 0,
          },
        ],
      }),
    ).toBe(false);
  });
});
