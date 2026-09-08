import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { thinkingLevelFor } from "./pi-runtime.js";

const model = (provider: string): Model<Api> =>
  ({
    provider,
    id: "gpt-6-astra",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  }) as Model<Api>;

describe("Astra thinking level scope", () => {
  it("keeps ultra only for the OpenAI Codex Astra identity", () => {
    expect(thinkingLevelFor(model("openai-codex"), "ultra")).toBe("ultra");
    expect(thinkingLevelFor(model("other-provider"), "ultra")).toBe("max");
  });
});
