import { describe, expect, it, vi } from "vitest";
import { pinLocalServiceHost } from "./local-service-endpoint.js";

describe("pinLocalServiceHost DNS failures", () => {
  it.each(["EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"])(
    "preserves the existing message and original %s cause",
    async (code) => {
      const cause = Object.assign(new Error("synthetic DNS failure"), { code });
      const resolveHostname = vi.fn(async () => {
        throw cause;
      });

      const error = await pinLocalServiceHost("http://memory.example.com", {
        allowPrivateEndpoint: true,
        resolveHostname,
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Local mode requires a loopback or private-network address.",
      );
      expect((error as Error).cause).toBe(cause);
      expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("memory.example.com");
    },
  );

  it("still refuses a resolved public address without inventing a DNS failure cause", async () => {
    const error = await pinLocalServiceHost("http://memory.example.com", {
      allowPrivateEndpoint: true,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Local mode requires a loopback or private-network address.",
    );
    expect((error as Error).cause).toBeUndefined();
  });
});
