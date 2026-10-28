import { describe, expect, it } from "vitest";
import type { IncomingShare } from "./incoming-share";
import { sharePreview } from "./share-preview";

const base: IncomingShare = { text: "", files: [], arrivedAt: 0, generation: 1 };
describe("share preview", () => {
  it.each(["A short note", "https://example.com/article"])("keeps text and links: %s", (text) => {
    expect(sharePreview({ ...base, text })).toEqual({
      text,
      images: [],
      extraImages: 0,
      fileCount: 0,
      fileName: null,
    });
  });
  it("limits thumbnails and counts the remaining images separately from files", () => {
    const images = Array.from({ length: 6 }, (_, index) => ({
      uri: `content://photos/${index}`,
      name: `${index}.png`,
      mimeType: "image/png",
    }));
    const preview = sharePreview({
      ...base,
      files: [
        ...images,
        { uri: "content://docs/1", name: "notes.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(preview.images).toEqual(images.slice(0, 4));
    expect(preview.extraImages).toBe(2);
    expect(preview.fileName).toBe("notes.pdf");
    expect(preview.fileCount).toBe(1);
  });
  it("uses a count for multiple other files", () => {
    const preview = sharePreview({
      ...base,
      files: Array.from({ length: 3 }, (_, i) => ({
        uri: `content://docs/${i}`,
        name: "file",
        mimeType: null,
      })),
    });
    expect(preview.fileCount).toBe(3);
    expect(preview.fileName).toBeNull();
  });
});
