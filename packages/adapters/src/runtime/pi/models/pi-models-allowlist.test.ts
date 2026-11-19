import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPATIBLE_ENDPOINT_PRESETS,
  compatibleEndpointPresetsFor,
} from "../../../models/endpoints/openai-compatible-url.js";
import { modelProviderAllowlist } from "../../../models/model-provider-allowlist.js";
import { listPiCatalog } from "./pi-models.js";

const savedAllowlist = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
  else process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = savedAllowlist;
});

describe("model provider allowlist in the catalog", () => {
  it("returns the cached catalog untouched when unset", () => {
    delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    const catalog = listPiCatalog();
    expect(listPiCatalog()).toBe(catalog);
    expect(new Set(catalog.map((entry) => entry.provider)).size).toBeGreaterThan(1);
    const presets = catalog.find(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    )?.endpointPresets;
    expect(presets).toEqual(COMPATIBLE_ENDPOINT_PRESETS);
    expect(compatibleEndpointPresetsFor(modelProviderAllowlist())).toEqual(
      COMPATIBLE_ENDPOINT_PRESETS,
    );
  });

  it("builds the filtered catalog once per distinct list", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    const first = listPiCatalog();
    expect(listPiCatalog()).toBe(first);
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter,anthropic";
    const second = listPiCatalog();
    expect(second).not.toBe(first);
    expect(second.some((entry) => entry.provider === "anthropic")).toBe(true);
  });

  it("keeps only the providers the list names", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    const catalog = listPiCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((entry) => entry.provider === "openrouter")).toBe(true);
  });

  it("drops a preset the list leaves out and keeps one it names", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = OPENAI_COMPATIBLE_PROVIDER_ID;
    const withoutPreset = listPiCatalog().find(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(withoutPreset?.endpointPresets).toEqual([]);

    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = `${OPENAI_COMPATIBLE_PROVIDER_ID},ollama-cloud`;
    const withPreset = listPiCatalog().find(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(withPreset?.endpointPresets).toEqual(COMPATIBLE_ENDPOINT_PRESETS);
  });
});
