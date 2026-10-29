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
    expect(name).toBe(`${"a".repeat(78)}.pdf`);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  it("preserves joiners within Persian and Indic names", () => {
    expect(artifactShareFileName("نامه\u200cها.pdf", "application/pdf")).toBe("نامه\u200cها.pdf");
    expect(artifactShareFileName("क्\u200dष.pdf", "application/pdf")).toBe("क्\u200dष.pdf");
  });

  it("does not retain isolated joiners or other controls", () => {
    expect(artifactShareFileName("👩\u200d💻.pdf", "application/pdf")).toBe("👩\u200d💻.pdf");
    expect(artifactShareFileName("a👩\u200d💻b.pdf", "application/pdf")).toBe("a👩\u200d💻b.pdf");
    expect(artifactShareFileName("a\u200db\u202ec.pdf", "application/pdf")).toBe("a\u200db_c.pdf");
    expect(artifactShareFileName("\u0301\u200d\u0301.pdf", "application/pdf")).toBe(
      "attachment.pdf",
    );
  });

  it.each([
    "👩‍💻",
    "👍🏽",
    "🇮🇷",
    "1️⃣",
    "#️⃣",
    "1⃣",
    "©️",
    "❤️",
    "😀️",
    "🏳️‍🌈",
    "❤️‍🔥",
    "👨‍👩‍👧‍👦",
    "🏴‍☠️",
    "👩‍🐱",
  ])("keeps a complete emoji sequence in %s.pdf", (emoji) =>
    expect(artifactShareFileName(`${emoji}.pdf`, "application/pdf")).toBe(`${emoji}.pdf`),
  );

  it("retains only complete emoji sequences and cleans paths and controls", () => {
    const flag = "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    const scotland = "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
    const wales = "🏴\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}";
    expect(artifactShareFileName(`${flag}.pdf`, "application/pdf")).toBe(`${flag}.pdf`);
    expect(artifactShareFileName(`${scotland}.pdf`, "application/pdf")).toBe(`${scotland}.pdf`);
    expect(artifactShareFileName(`${wales}.pdf`, "application/pdf")).toBe(`${wales}.pdf`);
    expect(artifactShareFileName("🇮.pdf", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName("../a/👩‍💻\u202e👍🏽.pdf", "application/pdf")).toBe(
      "a_👩‍💻_👍🏽.pdf",
    );
    expect(artifactShareFileName("🏽.pdf", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName("©.pdf", "application/pdf")).toBe("attachment.pdf");
    expect(artifactShareFileName("\ufe0fa.pdf", "application/pdf")).toBe("a.pdf");
    expect(artifactShareFileName("7\ufe0e.pdf", "application/pdf")).toBe("7\ufe0e.pdf");
    expect(artifactShareFileName("7\ufe0f.pdf", "application/pdf")).toBe("7\ufe0f.pdf");
    expect(artifactShareFileName("a\ufe0f\u200d\ufe0fb.pdf", "application/pdf")).toBe("a_b.pdf");
    expect(artifactShareFileName("a\u{e0100}\u200d\u{e0100}b.pdf", "application/pdf")).toBe(
      "a\u{e0100}_b.pdf",
    );
    expect(artifactShareFileName("字\u{e0100}.pdf", "application/pdf")).toBe("字\u{e0100}.pdf");
    expect(artifactShareFileName("ക്\u200cഷ.pdf", "application/pdf")).toBe("ക്\u200cഷ.pdf");
    expect(artifactShareFileName("\u0301\u200d\u0301.pdf", "application/pdf")).toBe(
      "attachment.pdf",
    );
    for (const name of [
      "👩\u200dA",
      "👩\u200d\u200d💻",
      "🏴\u{e0067}",
      "😀🏽",
      "🏴\u{e0067}\u{e0061}\u{e0061}\u{e0061}\u{e0061}\u{e007f}",
    ]) {
      expect(artifactShareFileName(`${name}.pdf`, "application/pdf")).not.toMatch(
        /[\u200d\u{e0067}]/u,
      );
    }
  });

  it("truncates complete emoji within the UTF-16 stem budget", () => {
    expect(artifactShareFileName(`${"a".repeat(75)}👩‍💻x.pdf`, "application/pdf")).toBe(
      `${"a".repeat(75)}👩‍💻.pdf`,
    );
    expect(artifactShareFileName(`${"a".repeat(76)}👩‍💻.pdf`, "application/pdf")).toBe(
      `${"a".repeat(76)}.pdf`,
    );
  });

  it("truncates only at grapheme boundaries within the stem budget", () => {
    expect(artifactShareFileName(`${"a".repeat(79)}हि.pdf`, "application/pdf")).toBe(
      `${"a".repeat(79)}.pdf`,
    );
    expect(artifactShareFileName(`${"a".repeat(79)}e\u0301.pdf`, "application/pdf")).toBe(
      `${"a".repeat(79)}.pdf`,
    );
    expect(artifactShareFileName(`a${"\u0301".repeat(80)}.pdf`, "application/pdf")).toBe(
      "attachment.pdf",
    );
    expect(artifactShareFileName(`${"a".repeat(79)}\u200db.pdf`, "application/pdf")).toBe(
      `${"a".repeat(79)}.pdf`,
    );
    expect(artifactShareFileName(`${"a".repeat(78)}\u200c\u0301b.pdf`, "application/pdf")).toBe(
      `${"a".repeat(78)}.pdf`,
    );
  });

  it("falls back for long stems when grapheme segmentation is unavailable", () => {
    const segmenter = Intl.Segmenter;
    try {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
      expect(artifactShareFileName(`${"a".repeat(79)}हि.pdf`, "application/pdf")).toBe(
        "attachment.pdf",
      );
      expect(artifactShareFileName("short.pdf", "application/pdf")).toBe("short.pdf");
      expect(artifactShareFileName(`${"a".repeat(90)}.pdf`, "application/pdf")).toBe(
        `${"a".repeat(80)}.pdf`,
      );
      expect(artifactShareFileName(`${"a".repeat(79)}\u{1D165}b.pdf`, "application/pdf")).toBe(
        "attachment.pdf",
      );
      expect(artifactShareFileName(`${"中".repeat(81)}.pdf`, "application/pdf")).toBe(
        "attachment.pdf",
      );
      expect(artifactShareFileName("a👩‍💻b.pdf", "application/pdf")).toBe("a_b.pdf");
    } finally {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: segmenter });
    }
  });

  it("keeps repeated emoji in one filename", () => {
    for (let i = 0; i < 2; i++) {
      expect(artifactShareFileName("😀😀a😀️😀.pdf", "application/pdf")).toBe("😀😀a😀️😀.pdf");
    }
  });

  it("keeps unicode letters in the display name", () => {
    expect(artifactShareFileName("会议记录.md", "text/markdown")).toBe("会议记录.md");
    expect(artifactShareFileName("报告.pdf", "application/pdf")).toBe("报告.pdf");
  });
});
