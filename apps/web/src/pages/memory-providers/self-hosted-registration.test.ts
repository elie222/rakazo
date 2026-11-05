import type { SpaceMemoryConfig } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

// Macros compile away in the app; the registration test only inspects form wiring.
vi.mock("@lingui/react/macro", () => ({ Trans: () => null, useLingui: () => ({ t: String.raw }) }));

import { MemmySettingsForm } from "./MemmySettingsForm";
import { memoryProviderSettings } from "./registry";

const config: SpaceMemoryConfig = {
  provider: "memmy",
  settings: { baseUrl: "https://memory.example.test" },
  defaultMemoryScope: "isolated",
  updatedAt: "2026-11-04T10:00:00Z",
};

describe("self-hosted memory registration", () => {
  it("uses a provider-neutral label without removing the connection form or changing its id", () => {
    const registration = memoryProviderSettings("memmy");
    expect(registration?.name).toBe("Self-hosted");
    expect(registration?.id).toBe(config.provider);
    expect(registration?.SettingsForm).toBe(MemmySettingsForm);
  });

  it("identifies a connected installation by its endpoint with a neutral fallback", () => {
    const registration = memoryProviderSettings("memmy");
    expect(registration?.connectedLabel(config)).toBe("https://memory.example.test");
    expect(registration?.connectedLabel({ ...config, settings: {} })).toBe("Self-hosted");
  });
});
