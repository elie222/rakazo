import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";

describe("reaction receipt", () => {
  it("preserves ok and optionally includes runs to refresh", () => {
    const schema = appContract.threads.react["~orpc"].outputSchema!;
    expect(schema.parse({ ok: true })).toEqual({ ok: true });
    expect(schema.parse({ ok: true, runIds: [] })).toEqual({ ok: true, runIds: [] });
    expect(schema.parse({ ok: true, runIds: ["run-1"] })).toEqual({ ok: true, runIds: ["run-1"] });
  });
});
