import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { reliableStreamOptions } from "./pi-runtime.js";

const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;

describe("temperature passthrough", () => {
  it("leaves temperature unset for ordinary runs", () => {
    expect(reliableStreamOptions(model).temperature).toBeUndefined();
  });

  it("pins the POTOO patrol temperature", () => {
    expect(reliableStreamOptions(model, undefined, undefined, undefined, 0.2).temperature).toBe(
      0.2,
    );
  });

  it("pins the POTOO escalation temperature", () => {
    expect(reliableStreamOptions(model, undefined, undefined, undefined, 0.3).temperature).toBe(
      0.3,
    );
  });
});
