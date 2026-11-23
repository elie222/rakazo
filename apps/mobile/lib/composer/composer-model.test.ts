import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MobileMe } from "../api/mobile-types";
import { composerModelChip } from "./composer-model";

// Only the label logic runs here; the reads and navigation are not exercised.
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("../query/query", () => ({ rpcQuery: vi.fn() }));
vi.mock("../query/screen-query", () => ({ useScreenQuery: vi.fn() }));

const me = { defaultProvider: "acme", defaultModel: "fast" } as MobileMe;
const catalog = [
  { provider: "acme", id: "fast", label: "Fast", providerName: "Acme" },
  {
    provider: "acme",
    id: "smart",
    label: "Smart",
    providerName: "Acme",
    thinkingLevels: ["low", "high"],
  },
] as unknown as ModelCatalogEntry[];
const credentials = [{ provider: "acme", label: "Acme" }] as unknown as ModelCredential[];

describe("composerModelChip", () => {
  it("names the Space default's model without its connection", () => {
    expect(composerModelChip({}, me, catalog, credentials)).toEqual({ label: "Fast" });
  });

  it("names the bot's own model and its thinking", () => {
    expect(
      composerModelChip(
        { modelProvider: "acme", modelId: "smart", thinkingLevel: "high" },
        me,
        catalog,
        credentials,
      ),
    ).toEqual({ label: "Smart", thinking: "High" });
  });

  it("still names the Space default's model with nothing connected", () => {
    expect(composerModelChip({}, me, catalog, [])).toEqual({ label: "Fast" });
  });
});
