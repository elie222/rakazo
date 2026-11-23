import { describe, expect, it } from "vitest";
import {
  IntegrationProviderConfigSchema,
  IntegrationProviderIdSchema,
} from "./integration-settings.js";

describe("integration provider ids", () => {
  it("accepts any id the adapters might register, leaving the check to them", () => {
    expect(IntegrationProviderIdSchema.parse("acme-connect")).toBe("acme-connect");
    expect(
      IntegrationProviderConfigSchema.parse({ provider: "acme-connect", apiKey: " key " }),
    ).toEqual({
      provider: "acme-connect",
      apiKey: "key",
    });
  });

  it("rejects an empty or oversized id", () => {
    expect(IntegrationProviderIdSchema.safeParse("").success).toBe(false);
    expect(IntegrationProviderIdSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});
