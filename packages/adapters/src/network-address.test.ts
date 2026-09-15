import dns from "node:dns";
import { describe, expect, it } from "vitest";
import {
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isPrivateAddress,
  withPinnedDnsLookup,
} from "./network-address.js";

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

  it.each([
    "169.254.169.254",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:0ec2:0000:0000:0000:0000:0000:0254",
    "::ffff:100.100.100.200",
    "64:ff9b::6464:64c8",
    "2002:6464:64c8::1",
  ])("classifies %s as a cloud metadata address", (address) => {
    expect(isCloudMetadataAddress(address)).toBe(true);
  });

  it.each(["10.0.0.1", "100.100.100.201", "fd00:ec2::255"])(
    "does not classify %s as a cloud metadata address",
    (address) => {
      expect(isCloudMetadataAddress(address)).toBe(false);
    },
  );
});

describe("pinned dns lookup", () => {
  it("returns the validated address for the pinned hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        const result = await new Promise<{ address: string; family?: number }>(
          (resolve, reject) => {
            dns.lookup("connectors.example.test", (error, address, family) => {
              if (error) reject(error);
              else resolve({ address: String(address), family });
            });
          },
        );
        expect(result).toEqual({ address: "203.0.113.10", family: 4 });
      },
    );
  });

  it("does not pin lookups for other hostnames", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        const result = await new Promise<string>((resolve, reject) => {
          dns.lookup("127.0.0.1", (error, address) => {
            if (error) reject(error);
            else resolve(String(address));
          });
        });
        expect(result).toBe("127.0.0.1");
      },
    );
  });

  it("pins dns.promises.lookup for the same hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        await expect(dns.promises.lookup("connectors.example.test")).resolves.toEqual({
          address: "203.0.113.10",
          family: 4,
        });
      },
    );
  });

  it("filters all-results lookups to the requested family", async () => {
    const dualStack = [
      { address: "203.0.113.10", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    await withPinnedDnsLookup("connectors.example.test", dualStack, async () => {
      const result = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
        dns.lookup("connectors.example.test", { all: true, family: 4 }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses as dns.LookupAddress[]);
        });
      });
      expect(result).toEqual([{ address: "203.0.113.10", family: 4 }]);
      await expect(
        dns.promises.lookup("connectors.example.test", { all: true, family: 6 }),
      ).resolves.toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    });
  });

  it("fails a family-filtered lookup when no matching address is pinned", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        await expect(
          new Promise((resolve, reject) => {
            dns.lookup("connectors.example.test", { all: true, family: 6 }, (error, addresses) => {
              if (error) reject(error);
              else resolve(addresses);
            });
          }),
        ).rejects.toThrow("Endpoint did not resolve to an address");
      },
    );
  });
});
