import { describe, expect, it } from "vitest";
import { splitConnectionAccounts } from "./connection-accounts.js";

describe("splitConnectionAccounts", () => {
  it("keeps revoked and failed attempts out of the account list while preserving one pending sign-in", () => {
    const result = splitConnectionAccounts([
      { id: "revoked", status: "revoked" },
      { id: "failed", status: "error" },
      { id: "active", status: "connected" },
      { id: "pending", status: "pending" },
    ]);

    expect(result.active.map((row) => row.id)).toEqual(["active"]);
    expect(result.pending.map((row) => row.id)).toEqual(["pending"]);
  });
});
