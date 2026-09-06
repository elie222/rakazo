import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { connectedModelOptions } from "./model-options";

function credential(input: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-1",
    provider: "xai",
    label: "xAI",
    hasKey: true,
    isDefault: true,
    ...input,
  };
}

const catalog: ModelCatalogEntry[] = [
  {
    provider: "xai",
    providerName: "xAI",
    id: "grok-4.6",
    label: "Grok 4.6",
    billing: "User key",
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    billing: "User key",
  },
];

describe("connected model options", () => {
  it("only exposes catalog models backed by a connected provider", () => {
    expect(connectedModelOptions([credential()], catalog)).toEqual([
      {
        key: "xai::grok-4.6",
        provider: "xai",
        modelId: "grok-4.6",
        label: "xAI · Grok 4.6",
      },
    ]);
  });

  it("keeps a free-form connected model without duplicating it", () => {
    expect(
      connectedModelOptions(
        [
          credential({ modelId: "private-model" }),
          credential({ id: "credential-2", modelId: "private-model" }),
        ],
        catalog,
      ),
    ).toEqual([
      {
        key: "xai::private-model",
        provider: "xai",
        modelId: "private-model",
        label: "xAI · private-model",
      },
    ]);
  });
});
