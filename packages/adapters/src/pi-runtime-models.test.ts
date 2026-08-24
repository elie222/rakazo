import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { modelsForRequest } from "./pi-runtime.js";

function requestModel(id: string, baseUrl: string): Pick<AgentRunRequest, "model"> {
  return { model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id, baseUrl } };
}

describe("request model catalogs", () => {
  it("isolates concurrent OpenAI-compatible endpoint registrations", () => {
    const first = modelsForRequest(
      requestModel("first-model", "http://127.0.0.1:8001/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const second = modelsForRequest(
      requestModel("second-model", "http://127.0.0.1:8002/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(first).not.toBe(second);
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "first-model")?.baseUrl).toBe(
      "http://127.0.0.1:8001/v1",
    );
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")).toBeUndefined();
    expect(second.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")?.baseUrl).toBe(
      "http://127.0.0.1:8002/v1",
    );
  });
});
