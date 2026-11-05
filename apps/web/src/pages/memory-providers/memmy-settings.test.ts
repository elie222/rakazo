import { describe, expect, it } from "vitest";
import {
  MEMMY_ENDPOINT_PLACEHOLDER,
  memmyConnectionDraft,
  memmyEndpointError,
} from "./memmy-settings";

describe("Memmy memory provider settings", () => {
  it("requires an explicit service URL and leaves URL validity to the backend", () => {
    expect(memmyEndpointError("")).toBe("required");
    expect(memmyEndpointError("   ")).toBe("required");
    expect(memmyEndpointError("not a url")).toBeNull();
    expect(memmyEndpointError("ftp://memory.example.test")).toBeNull();
    expect(memmyEndpointError("https://user:pass@memory.example.test")).toBeNull();
    expect(memmyEndpointError(MEMMY_ENDPOINT_PLACEHOLDER)).toBeNull();
  });

  it("builds a connection draft with no model fields", () => {
    expect(memmyConnectionDraft({ endpoint: "", token: "service-token" })).toEqual({
      ok: false,
      error: "required",
    });

    expect(
      memmyConnectionDraft({ endpoint: "  http://127.0.0.1:18960  ", token: " service-token " }),
    ).toEqual({
      ok: true,
      draft: {
        // Model choice is the memory service's own setting, so the draft carries only the
        // connection: URL plus token.
        settings: { baseUrl: "http://127.0.0.1:18960" },
        credentials: { token: "service-token" },
      },
    });
  });
});
