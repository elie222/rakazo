import { describe, expect, it } from "vitest";
import {
  CatalogSlug,
  CreateConnectorInput,
  CreateGlobalBotInput,
  GlobalBotSchema,
  parseConnectorMcpConfig,
  SetSpacePermissionsInput,
  UpdateGlobalBotInput,
} from "./global-bots.js";

describe("CatalogSlug", () => {
  it("accepts lowercase slugs", () => {
    expect(CatalogSlug.parse("dana")).toBe("dana");
    expect(CatalogSlug.parse("finance-bot_1")).toBe("finance-bot_1");
  });

  it("rejects uppercase and empty", () => {
    expect(CatalogSlug.safeParse("Dana").success).toBe(false);
    expect(CatalogSlug.safeParse("").success).toBe(false);
  });
});

describe("CreateGlobalBotInput", () => {
  it("defaults empty profile fields", () => {
    const parsed = CreateGlobalBotInput.parse({
      slug: "dana",
      name: "Dana",
      color: "#3EC5A8",
    });
    expect(parsed.title).toBe("");
    expect(parsed.description).toBe("");
    expect(parsed.instructions).toBe("");
    expect(parsed.disabledBuiltinTools).toEqual([]);
  });
});

describe("UpdateGlobalBotInput", () => {
  it("requires at least one patch field", () => {
    expect(UpdateGlobalBotInput.safeParse({ globalBotId: "g1" }).success).toBe(false);
    expect(
      UpdateGlobalBotInput.safeParse({ globalBotId: "g1", name: "Dana" }).success,
    ).toBe(true);
  });
});

describe("CreateConnectorInput", () => {
  it("defaults skill refs and version", () => {
    const parsed = CreateConnectorInput.parse({
      slug: "monarch",
      name: "Monarch",
    });
    expect(parsed.skillRefs).toEqual([]);
    expect(parsed.version).toBe("1");
  });
});

describe("GlobalBotSchema", () => {
  it("round-trips a published catalog row", () => {
    const row = GlobalBotSchema.parse({
      id: "g1",
      slug: "dana",
      name: "Dana",
      title: "Finance",
      description: "Keeps the books",
      instructions: "Be careful with money",
      color: "#3EC5A8",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      disabledBuiltinTools: [],
      publishedAt: "2026-10-28T00:00:00.000Z",
      connectorIds: ["c1"],
      createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z",
    });
    expect(row.connectorIds).toEqual(["c1"]);
  });
});

describe("SetSpacePermissionsInput", () => {
  it("accepts finance permissions", () => {
    expect(
      SetSpacePermissionsInput.parse({
        roles: [{ role: "member", permissions: ["finance.read", "finance.write"] }],
      }).roles[0]?.permissions,
    ).toEqual(["finance.read", "finance.write"]);
  });
});

describe("parseConnectorMcpConfig", () => {
  it("defaults empty configs and keeps allowlists", () => {
    expect(parseConnectorMcpConfig(undefined)).toEqual({ serverSlugs: [] });
    expect(parseConnectorMcpConfig({ serverSlugs: ["books"], allowedToolsBySlug: { books: ["list"] } })).toEqual({
      serverSlugs: ["books"],
      allowedToolsBySlug: { books: ["list"] },
    });
  });

  it("falls back when the payload is invalid", () => {
    expect(parseConnectorMcpConfig({ serverSlugs: ["BAD SLUG"] })).toEqual({ serverSlugs: [] });
  });
});
