import { describe, expect, it } from "vitest";
import { deepInfraModelList } from "./deepinfra-models.js";

const entries = [
  {
    id: "fixture/plain-chat",
    metadata: {
      context_length: 163840,
      pricing: { input_tokens: 0.26, output_tokens: 0.38, cache_read_tokens: 0.13 },
      tags: ["chat", "prompt_cache"],
    },
  },
  {
    id: "fixture/vision-effort",
    metadata: {
      context_length: 262144,
      pricing: { input_tokens: 0.2, output_tokens: 1 },
      tags: ["chat", "vlm", "vision", "prompt_cache", "reasoning_effort", "reasoning"],
    },
  },
  {
    id: "fixture/always-thinking",
    metadata: { context_length: 202752, tags: ["chat", "reasoning"] },
  },
  { id: "fixture/vlm-only", metadata: { tags: ["chat", "vlm"] } },
  { id: "fixture/image-gen", metadata: { tags: ["image-gen"] } },
  { id: "fixture/embedding", metadata: { context_length: 8192, tags: ["embed"] } },
  { id: "fixture/no-metadata" },
  { id: "fixture/tags-not-a-list", metadata: { tags: "chat" } },
  {
    id: "fixture/malformed-values",
    metadata: {
      context_length: -5,
      pricing: { input_tokens: "free", cache_read_tokens: Number.NaN },
      tags: ["chat", "prompt_cache", 7, null],
    },
  },
  {
    id: "fixture/out-of-range",
    metadata: {
      context_length: 1.5,
      pricing: { input_tokens: -1, cache_read_tokens: 0.1 },
      tags: ["chat", "prompt_cache"],
    },
  },
  {
    id: "fixture/huge-window",
    metadata: { context_length: Number.MAX_SAFE_INTEGER, tags: ["chat"] },
  },
];
const ids = entries.map((entry) => entry.id);

describe("deepInfraModelList", () => {
  const { models, details } = deepInfraModelList(entries, ids);
  const detail = (id: string) => details.find((entry) => entry.id === id);

  it("keeps chat models, and models with no tags list, in listing order", () => {
    expect(models).toEqual([
      "fixture/plain-chat",
      "fixture/vision-effort",
      "fixture/always-thinking",
      "fixture/vlm-only",
      "fixture/no-metadata",
      "fixture/tags-not-a-list",
      "fixture/malformed-values",
      "fixture/out-of-range",
      "fixture/huge-window",
    ]);
  });

  it("maps context length and cached-read pricing", () => {
    expect(detail("fixture/plain-chat")).toEqual({
      id: "fixture/plain-chat",
      supportsImages: false,
      reasoning: false,
      contextWindow: 163840,
      cacheCapabilities: {
        scope: "account",
        retentionMode: "short",
        inputCostPerMillion: 0.26,
        readCostPerMillion: 0.13,
      },
    });
  });

  it("maps vision tags to images and reasoning_effort to thinking", () => {
    expect(detail("fixture/vision-effort")).toEqual({
      id: "fixture/vision-effort",
      supportsImages: true,
      reasoning: true,
      contextWindow: 262144,
    });
    expect(detail("fixture/vlm-only")).toEqual({
      id: "fixture/vlm-only",
      supportsImages: true,
      reasoning: false,
    });
  });

  it("does not offer thinking for always-thinking models without effort control", () => {
    expect(detail("fixture/always-thinking")?.reasoning).toBe(false);
  });

  it("returns no details for models whose metadata is missing or has no tags list", () => {
    expect(detail("fixture/no-metadata")).toBeUndefined();
    expect(detail("fixture/tags-not-a-list")).toBeUndefined();
  });

  it("drops malformed and out-of-range values but keeps the model", () => {
    expect(detail("fixture/malformed-values")).toEqual({
      id: "fixture/malformed-values",
      supportsImages: false,
      reasoning: false,
    });
    expect(detail("fixture/out-of-range")).toEqual({
      id: "fixture/out-of-range",
      supportsImages: false,
      reasoning: false,
      cacheCapabilities: { scope: "account", retentionMode: "short", readCostPerMillion: 0.1 },
    });
    expect(detail("fixture/huge-window")?.contextWindow).toBeUndefined();
  });

  it.each([
    ["a non-chat entry comes first", false],
    ["the chat entry comes first", true],
  ])("offers a duplicated id once with its chat entry's details when %s", (_, chatFirst) => {
    const chat = { id: "fixture/dup", metadata: { context_length: 4096, tags: ["chat", "vlm"] } };
    const other = { id: "fixture/dup", metadata: { tags: ["embed"] } };
    const listed = chatFirst ? [chat, other] : [other, chat];
    expect(
      deepInfraModelList(
        listed,
        listed.map((entry) => entry.id),
      ),
    ).toEqual({
      models: ["fixture/dup"],
      details: [{ id: "fixture/dup", supportsImages: true, reasoning: false, contextWindow: 4096 }],
    });
  });

  it("only describes ids the probe accepted and skips null entries", () => {
    const result = deepInfraModelList(
      [
        { id: "fixture/plain-chat", metadata: { tags: ["chat"] } },
        { id: "fixture/not-accepted", metadata: { tags: ["chat"] } },
        null as never,
      ],
      ["fixture/plain-chat"],
    );
    expect(result).toEqual({
      models: ["fixture/plain-chat"],
      details: [{ id: "fixture/plain-chat", supportsImages: false, reasoning: false }],
    });
  });

  it("keeps models whose tags list is empty or has no string tags, without details", () => {
    const result = deepInfraModelList(
      [
        { id: "fixture/empty-tags", metadata: { tags: [], context_length: 8192 } },
        { id: "fixture/junk-tags", metadata: { tags: [null, 7], context_length: 8192 } },
      ],
      ["fixture/empty-tags", "fixture/junk-tags"],
    );
    expect(result).toEqual({ models: ["fixture/empty-tags", "fixture/junk-tags"], details: [] });
  });
});
