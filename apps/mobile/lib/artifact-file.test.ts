import { describe, expect, it } from "vitest";
import { artifactCacheFileName } from "./artifact-file.js";

describe("artifactCacheFileName", () => {
  it("uses the server id instead of an untrusted display name", () => {
    expect(artifactCacheFileName("../artifact/one", "application/pdf")).toBe("___artifact_one.pdf");
  });
});
