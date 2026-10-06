import { describe, expect, it } from "vitest";
import { artifactCacheFileName, artifactShareFileName } from "./artifact-file.js";

describe("artifactCacheFileName", () => {
  it("uses the server id instead of an untrusted display name", () => {
    expect(artifactCacheFileName("../artifact/one", "application/pdf")).toBe("___artifact_one.pdf");
    expect(artifactCacheFileName("markdown-one", "text/markdown")).toBe("markdown-one.md");
  });
});

describe("artifactShareFileName", () => {
  it("keeps a sanitized display name and its extension", () => {
    expect(artifactShareFileName("weekly-brief.md", "text/markdown")).toBe("weekly-brief.md");
    expect(artifactShareFileName("chief-mark.png", "image/png")).toBe("chief-mark.png");
  });

  it("drops path characters from the display name", () => {
    expect(artifactShareFileName("../weekly-brief.md", "text/markdown")).toBe("weekly-brief.md");
    expect(artifactShareFileName("..", "text/markdown")).toBe("attachment.md");
  });

  it("keeps unicode letters in the display name", () => {
    expect(artifactShareFileName("会议记录.md", "text/markdown")).toBe("会议记录.md");
    expect(artifactShareFileName("报告.pdf", "application/pdf")).toBe("报告.pdf");
  });
});
