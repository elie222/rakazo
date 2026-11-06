import { describe, expect, it } from "vitest";
import {
  formatToolFileSize,
  toolFileMention,
  toolFilePathPlaceholder,
  toolFilePlaceholder,
  toolFilePlaceholders,
  toolFileUrlPlaceholder,
} from "./tool-files.js";

describe("tool file placeholders", () => {
  it("round-trips both forms and finds every placeholder in a string", () => {
    const text = `a ${toolFilePlaceholder("cm1abc")} b ${toolFileUrlPlaceholder("cm2def")} c ${toolFilePathPlaceholder("cm3ghi")}`;
    expect(toolFilePlaceholders(text)).toEqual([
      { id: "cm1abc", form: "base64", text: "{{file:cm1abc}}" },
      { id: "cm2def", form: "url", text: "{{file_url:cm2def}}" },
      { id: "cm3ghi", form: "path", text: "{{file_path:cm3ghi}}" },
    ]);
  });

  it("ignores lookalikes that are not placeholders", () => {
    expect(
      toolFilePlaceholders("{{file:}} {{files:x}} {{file:a b}} {file:x} {{file_dir:x}}"),
    ).toEqual([]);
  });

  it("describes the file and both ways to pass it on", () => {
    const mention = toolFileMention({
      id: "cm1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      size: 312_000,
    });
    expect(mention).toContain('"invoice.pdf"');
    expect(mention).toContain("305 KB");
    expect(mention).toContain("{{file:cm1}}");
    expect(mention).toContain("{{file_url:cm1}}");
    expect(mention).toContain("{{file_path:cm1}}");
    expect(formatToolFileSize(512)).toBe("512 B");
    expect(formatToolFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
