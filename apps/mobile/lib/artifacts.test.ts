import { describe, expect, it, vi } from "vitest";
import { artifactThreadTarget, matchesArtifactQuery, mimeBadgeLabel } from "./artifacts";

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("./api", () => ({ rpc: vi.fn() }));

describe("mimeBadgeLabel", () => {
  it("labels the well-known artifact mime types", () => {
    expect(mimeBadgeLabel("text/html")).toBe("HTML");
    expect(mimeBadgeLabel("text/markdown")).toBe("MD");
    expect(mimeBadgeLabel("application/pdf")).toBe("PDF");
  });

  it("falls back to the subtype for anything else", () => {
    expect(mimeBadgeLabel("image/png")).toBe("PNG");
    expect(mimeBadgeLabel("application/json")).toBe("JSON");
  });
});

describe("matchesArtifactQuery", () => {
  const item = { name: "Landing page draft.html", description: "Hero + pricing section" };

  it("matches an empty query", () => {
    expect(matchesArtifactQuery(item, "")).toBe(true);
    expect(matchesArtifactQuery(item, "   ")).toBe(true);
  });

  it("matches case-insensitively against the name or description", () => {
    expect(matchesArtifactQuery(item, "LANDING")).toBe(true);
    expect(matchesArtifactQuery(item, "pricing")).toBe(true);
    expect(matchesArtifactQuery(item, "nope")).toBe(false);
  });

  it("handles a null description", () => {
    expect(matchesArtifactQuery({ name: "Notes.md", description: null }, "notes")).toBe(true);
    expect(matchesArtifactQuery({ name: "Notes.md", description: null }, "hero")).toBe(false);
  });
});

describe("artifactThreadTarget", () => {
  it("points at the bot or the group the artifact belongs to", () => {
    expect(artifactThreadTarget({ botId: "bot-1", groupId: null })).toEqual({ botId: "bot-1" });
    expect(artifactThreadTarget({ botId: null, groupId: "group-1" })).toEqual({
      groupId: "group-1",
    });
  });

  it("prefers the group when both are set, and has no target when neither is", () => {
    expect(artifactThreadTarget({ botId: "bot-1", groupId: "group-1" })).toEqual({
      groupId: "group-1",
    });
    expect(artifactThreadTarget({ botId: null, groupId: null })).toBeNull();
  });
});
