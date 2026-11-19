import { describe, expect, it } from "vitest";
import type { ResolvedAddress } from "./network-address.js";
import { createAddressCheckedLookup } from "./network-address.js";

const V6A = { address: "2001:db8::1", family: 6 };
const V6B = { address: "2001:db8:1::2", family: 6 };
const V4A = { address: "192.0.2.10", family: 4 };
const V4B = { address: "198.51.100.20", family: 4 };

function lookupWith(addresses: ResolvedAddress[], options: unknown) {
  const lookup = createAddressCheckedLookup(
    async () => addresses,
    () => {},
  );
  return new Promise<{ address: unknown; family?: number }>((resolve, reject) =>
    (
      lookup as (
        h: string,
        o: unknown,
        cb: (e: Error | null, a: unknown, f?: number) => void,
      ) => void
    )("dual-stack.example", options, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    ),
  );
}

describe("egress lookup prefers IPv4", () => {
  it("connects to an IPv4 address when DNS lists IPv6 first", async () => {
    await expect(lookupWith([V6A, V4A, V6B, V4B], {})).resolves.toEqual({
      address: V4A.address,
      family: 4,
    });
  });
  it("keeps DNS order for all:true (callers that race families pick for themselves)", async () => {
    const { address } = await lookupWith([V6A, V4A, V6B, V4B], { all: true });
    expect(address).toEqual([V6A, V4A, V6B, V4B]);
  });
  it("still honours an explicit family and an IPv6-only host", async () => {
    await expect(lookupWith([V4A, V6A], { family: 6 })).resolves.toEqual({
      address: V6A.address,
      family: 6,
    });
    await expect(lookupWith([V6A, V6B], {})).resolves.toEqual({ address: V6A.address, family: 6 });
  });
  it("still runs the address check on every answer", async () => {
    const seen: ResolvedAddress[][] = [];
    const lookup = createAddressCheckedLookup(
      async () => [V6A, V4A],
      (a) => {
        seen.push(a);
      },
    );
    await new Promise<void>((resolve) =>
      (lookup as (h: string, o: unknown, cb: () => void) => void)("x", {}, () => resolve()),
    );
    expect(seen).toEqual([[V6A, V4A]]);
  });
});
