import { describe, expect, it } from "vitest";
import { RECEIVED_FILE_MAX_AGE_MS } from "./received-path.js";

describe("RECEIVED_FILE_MAX_AGE_MS", () => {
  it("prunes after 31 days", () => {
    expect(RECEIVED_FILE_MAX_AGE_MS).toBe(31 * 24 * 60 * 60_000);
  });
});
