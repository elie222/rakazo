import { RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  persistResponseStreamingPreference,
  resolveResponseStreamingPreference,
} from "./response-streaming";

describe("response streaming preference", () => {
  it("prefers the saved choice over the env default", () => {
    expect(
      resolveResponseStreamingPreference({
        stored: "off",
        envDefault: "on",
      }),
    ).toBe("off");
  });

  it("uses VITE_DEFAULT_RESPONSE_STREAMING when nothing is saved", () => {
    expect(
      resolveResponseStreamingPreference({
        stored: null,
        envDefault: "off",
      }),
    ).toBe("off");
    expect(
      resolveResponseStreamingPreference({
        stored: null,
        envDefault: null,
      }),
    ).toBe("on");
  });

  it("treats an empty stored value as on, not as missing", () => {
    expect(
      resolveResponseStreamingPreference({
        stored: "",
        envDefault: "off",
      }),
    ).toBe("on");
  });

  it("persists through storage helpers", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    persistResponseStreamingPreference("off", storage);
    expect(store.get(RESPONSE_STREAMING_STORAGE_KEY)).toBe("off");
    expect(resolveResponseStreamingPreference({ storage })).toBe("off");
  });
});
