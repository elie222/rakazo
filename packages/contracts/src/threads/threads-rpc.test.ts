import { describe, expect, it } from "vitest";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.js";
import { threadsRpc } from "./threads-rpc.js";

describe("space search input", () => {
  const input = threadsRpc.search.query["~orpc"].inputSchema!;

  it("accepts a query up to the shared length limit and rejects one longer", () => {
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(200);
    expect(input.safeParse({ q: "a".repeat(SEARCH_QUERY_MAX_LENGTH) }).success).toBe(true);
    expect(input.safeParse({ q: "a".repeat(SEARCH_QUERY_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
