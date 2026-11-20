import type { ModelSettings } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { serializeModelSecret } from "../../models/model-secret.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolvedModelRunFields, resolveModelKey } from "./run-model.js";

const resolved = { apiKey: "fixture-key", redact: [], callObserver: undefined, connectionId: "c" };

it("runs at the level the model's settings chose when the run chose none", () => {
  const withLevel = { ...resolved, reasoning: true, thinkingLevel: "max" as const };
  expect(resolvedModelRunFields(withLevel, null).thinkingLevel).toBe("max");
  expect(resolvedModelRunFields(withLevel).thinkingLevel).toBe("max");
  expect(resolvedModelRunFields(withLevel, "low").thinkingLevel).toBe("low");
  expect(resolvedModelRunFields(withLevel, "off").thinkingLevel).toBe("off");
  expect(resolvedModelRunFields(resolved, null).thinkingLevel).toBeNull();
});

it("runs a model at its own level, else at the one its connection keeps for that model", async () => {
  const credential = {
    id: "connection-fixture",
    secretId: "secret-fixture",
    provider: "openai-compatible",
    defaultModel: "served",
    thinkingLevel: "high",
  };
  const level = async (modelId: string, models?: Record<string, ModelSettings>) => {
    const secret = serializeModelSecret({
      kind: "openai_compatible",
      apiKey: "fixture-key",
      baseUrl: "https://models.example.com/v1",
      enabledModelIds: ["served", "other"],
      models,
    });
    const deps = {
      billingEnabled: false,
      prisma: {
        secret: { findFirst: async () => ({ id: credential.secretId, ciphertext: "sealed" }) },
      },
      secretStore: { load: async () => secret },
    } as unknown as ExecutorDeps;
    const key = await resolveModelKey(
      deps,
      "user",
      "space",
      credential,
      credential.provider,
      modelId,
    );
    return resolvedModelRunFields(key).thinkingLevel;
  };
  expect(await level("served")).toBe("high");
  expect(await level("other")).toBeNull();
  expect(await level("served", { served: { reasoning: true, thinkingLevel: "max" } })).toBe("max");
});
