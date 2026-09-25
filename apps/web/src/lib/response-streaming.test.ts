import { RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  persistResponseStreamingPreference,
  resolveResponseStreamingPreference,
} from "./response-streaming";

describe("response streaming preference", () => {
  it("leaves streaming off unless a saved choice turns it on", () => {
    expect(resolveResponseStreamingPreference({ stored: "on" })).toBe("on");
    expect(resolveResponseStreamingPreference({ stored: "off" })).toBe("off");
    expect(resolveResponseStreamingPreference({ stored: null })).toBe("off");
    expect(resolveResponseStreamingPreference({ stored: "" })).toBe("off");
  });

  it("persists through storage helpers", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    persistResponseStreamingPreference("on", storage);
    expect(store.get(RESPONSE_STREAMING_STORAGE_KEY)).toBe("on");
    expect(resolveResponseStreamingPreference({ storage })).toBe("on");
  });
});
