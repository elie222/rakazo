import { describe, expect, it, vi } from "vitest";
import {
  classifyMemmyConnectionSettings,
  memmyRequiresPrivateEndpoint,
  revalidateMemmySettings,
} from "./memmy-connection-trust.js";
import type { ResolvedAddress } from "./network-address.js";

function resolvesTo(...addresses: string[]) {
  return vi.fn(
    async (): Promise<ResolvedAddress[]> =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
}

describe("memmyRequiresPrivateEndpoint", () => {
  it.each([
    ["http://127.0.0.1:8080", true],
    ["http://localhost:8080", true],
    ["http://[::1]:8080", true],
    // Synthetic private/address and hostname categories cannot use a public example.com URL.
    ["https://[fd00::1]:8080", true],
    ["https://example.local:8080", true],
    ["https://example:8080", true],
    ["http://memory.example.com", true],
    ["https://memory.example.com", false],
    ["https://memory.example.com/memmy", false],
    ["not a url", true],
  ])("%s → %s", (baseUrl, expected) => {
    expect(memmyRequiresPrivateEndpoint({ baseUrl })).toBe(expected);
  });

  it("fails closed without a base URL", () => {
    expect(memmyRequiresPrivateEndpoint({})).toBe(true);
  });

  it("honors a classified private trust on a public-looking URL", () => {
    expect(
      memmyRequiresPrivateEndpoint({
        baseUrl: "https://memory.example.com",
        endpointTrust: "private",
      }),
    ).toBe(true);
  });
});

describe("classifyMemmyConnectionSettings", () => {
  it("marks a public name that resolves to the server network as private", async () => {
    const resolve = resolvesTo("127.0.0.1");
    await expect(
      classifyMemmyConnectionSettings({ baseUrl: "https://memory.example.com/" }, resolve),
    ).resolves.toEqual({ baseUrl: "https://memory.example.com", endpointTrust: "private" });
    expect(resolve).toHaveBeenCalledWith("memory.example.com");
  });

  it("writes no trust field for a public answer and drops a stale one", async () => {
    await expect(
      classifyMemmyConnectionSettings(
        { baseUrl: "https://memory.example.com", endpointTrust: "private", ownerId: "o" },
        resolvesTo("203.0.113.10"),
      ),
    ).resolves.toEqual({ baseUrl: "https://memory.example.com", ownerId: "o" });
  });

  it("marks loopback private without resolving", async () => {
    const resolve = resolvesTo("203.0.113.10");
    await expect(
      classifyMemmyConnectionSettings({ baseUrl: "http://127.0.0.1:8080" }, resolve),
    ).resolves.toEqual({ baseUrl: "http://127.0.0.1:8080", endpointTrust: "private" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["a metadata literal", "http://169.254.169.254", resolvesTo()],
    ["a link-local literal", "https://169.254.10.10", resolvesTo()],
    ["a metadata name", "http://metadata.google.internal", resolvesTo()],
    ["a name resolving to metadata", "https://memory.example.com", resolvesTo("169.254.169.254")],
    [
      "a name resolving partly to link-local",
      "https://memory.example.com",
      resolvesTo("203.0.113.10", "fe80::1"),
    ],
    ["a name with no addresses", "https://memory.example.com", resolvesTo()],
  ])("refuses %s", async (_label, baseUrl, resolve) => {
    await expect(classifyMemmyConnectionSettings({ baseUrl }, resolve)).rejects.toThrow();
  });

  it("rejects a missing or malformed base URL", async () => {
    await expect(classifyMemmyConnectionSettings({})).rejects.toThrow("baseUrl is required");
    await expect(
      classifyMemmyConnectionSettings({ baseUrl: "https://u:p@memory.example.com" }),
    ).rejects.toThrow("HTTP(S)");
  });
});

describe("revalidateMemmySettings", () => {
  it("skips DNS for a public endpoint; its transport checks each connection", async () => {
    await expect(
      revalidateMemmySettings({ baseUrl: "https://memory.example.com" }),
    ).resolves.toBeUndefined();
  });

  it("accepts a saved loopback endpoint and refuses a saved metadata target", async () => {
    await expect(
      revalidateMemmySettings({ baseUrl: "http://127.0.0.1:8080", endpointTrust: "private" }),
    ).resolves.toBeUndefined();
    await expect(
      revalidateMemmySettings({ baseUrl: "http://169.254.169.254", endpointTrust: "private" }),
    ).rejects.toThrow();
  });
});
