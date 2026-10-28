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

  it.each(["हिन्दी.pdf", "บันทึก.pdf", "Re\u0301sume\u0301.pdf"])(
    "keeps combining marks in %s",
    (name) => {
      expect(artifactShareFileName(name, "application/pdf")).toBe(name);
    },
  );

  it("sanitizes separators and invalid characters while keeping marks", () => {
    expect(artifactShareFileName("../हिन्दी/บันทึก?:.pdf", "application/pdf")).toBe("हिन्दी_บันทึก.pdf");
    expect(artifactShareFileName("///", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName("\u0301", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName("\u0301/\u0301", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName(`${"a".repeat(80)}extra.pdf`, "application/pdf")).toBe(
      `${"a".repeat(80)}.pdf`,
    );
  });

  it("does not split a supplementary combining mark at the length limit", () => {
    const name = artifactShareFileName(`${"a".repeat(79)}\u{1D165}.pdf`, "application/pdf");
    expect(name).toBe(`${"a".repeat(79)}.pdf`);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  it("keeps unicode letters in the display name", () => {
    expect(artifactShareFileName("会议记录.md", "text/markdown")).toBe("会议记录.md");
    expect(artifactShareFileName("报告.pdf", "application/pdf")).toBe("报告.pdf");
  });
});
