import dns from "node:dns";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAddress } from "./network-address.js";
import { createAddressCheckedLookup } from "./network-address.js";

const V6A = { address: "2001:db8::1", family: 6 };
const V6B = { address: "2001:db8:1::2", family: 6 };
const V4A = { address: "192.0.2.10", family: 4 };
const V4B = { address: "198.51.100.20", family: 4 };

type LookupCallback = (error: Error | null, address: unknown, family?: number) => void;
type CallbackLookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

function useResultOrder(order: ReturnType<typeof dns.getDefaultResultOrder>) {
  vi.spyOn(dns, "getDefaultResultOrder").mockReturnValue(order);
}

function lookupWith(addresses: ResolvedAddress[], options: unknown) {
  const lookup = createAddressCheckedLookup(
    async () => addresses,
    () => {},
  ) as CallbackLookup;
  const answer = deferred<{ address: unknown; family?: number }>();
  lookup("dual-stack.example", options, (error, address, family) => {
    if (error) answer.reject(error);
    else answer.resolve({ address, family });
  });
  return answer.promise;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("egress lookup follows Node's DNS result order", () => {
  it("keeps the first DNS answer by default (verbatim)", async () => {
    useResultOrder("verbatim");
    await expect(lookupWith([V6A, V4A, V6B, V4B], {})).resolves.toEqual({
      address: V6A.address,
      family: 6,
    });
  });

  it("connects to an IPv4 address under --dns-result-order=ipv4first", async () => {
    useResultOrder("ipv4first");
    await expect(lookupWith([V6A, V4A, V6B, V4B], {})).resolves.toEqual({
      address: V4A.address,
      family: 4,
    });
  });

  it("connects to an IPv6 address under --dns-result-order=ipv6first", async () => {
    useResultOrder("ipv6first");
    await expect(lookupWith([V4A, V6A, V4B], {})).resolves.toEqual({
      address: V6A.address,
      family: 6,
    });
  });

  it("keeps DNS order for all:true (callers that race families pick for themselves)", async () => {
    useResultOrder("ipv4first");
    const { address } = await lookupWith([V6A, V4A, V6B, V4B], { all: true });
    expect(address).toEqual([V6A, V4A, V6B, V4B]);
  });

  it("honours an explicit family and a single-family host", async () => {
    useResultOrder("ipv4first");
    await expect(lookupWith([V4A, V6A], { family: 6 })).resolves.toEqual({
      address: V6A.address,
      family: 6,
    });
    await expect(lookupWith([V6A, V6B], {})).resolves.toEqual({ address: V6A.address, family: 6 });
  });

  it("still runs the address check on every answer", async () => {
    useResultOrder("ipv4first");
    const seen: ResolvedAddress[][] = [];
    const lookup = createAddressCheckedLookup(
      async () => [V6A, V4A],
      (answers) => {
        seen.push(answers);
      },
    ) as CallbackLookup;
    const done = deferred();
    lookup("x", {}, () => done.resolve());
    await done.promise;
    expect(seen).toEqual([[V6A, V4A]]);
  });
});
