import { ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logUnexpectedRpcError } from "./app.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays quiet for an error the router chose to return", () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(logError).not.toHaveBeenCalled();
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    const logged = logError.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("rpc computer/screenUrl failed");
    expect(logged).toContain("fetch failed");
    expect(logged).toContain("connect ECONNREFUSED 127.0.0.1:7091");
  });
});
