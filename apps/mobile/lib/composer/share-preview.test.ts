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
  it("previews filename-based photos with missing or generic MIME types", () => {
    const images = [
      { uri: "file:///shared/photo.jpeg", name: "photo.jpeg", mimeType: null },
      {
        uri: "content://shared/1",
        name: "picture.PNG",
        mimeType: "application/octet-stream",
      },
    ];
    const preview = sharePreview({
      ...base,
      files: [...images, { uri: "content://shared/2", name: "notes.pdf", mimeType: null }],
    });
    expect(preview.images).toEqual(images);
    expect(preview.extraImages).toBe(0);
    expect(preview.fileCount).toBe(1);
    expect(preview.fileName).toBe("notes.pdf");
  });
  it("falls back to URI extensions when the filename has no type", () => {
    const images = [
      { uri: "file:///shared/photo.JPG", name: "file", mimeType: null },
      {
        uri: "content://shared/picture.png?download=1#preview",
        name: "file",
        mimeType: "application/octet-stream",
      },
    ];
    const preview = sharePreview({ ...base, files: images });
    expect(preview.images).toEqual(images);
    expect(preview.fileCount).toBe(0);
  });
  it("keeps real files generic and respects explicit non-image MIME types", () => {
    const preview = sharePreview({
      ...base,
      files: [
        { uri: "file:///shared/notes.pdf", name: "notes.pdf", mimeType: null },
        { uri: "content://shared/1", name: "archive.zip", mimeType: "application/octet-stream" },
        { uri: "content://shared/2", name: "photo.jpg", mimeType: "application/pdf" },
        { uri: "content://shared/3", name: "photo.png", mimeType: "application/x-custom" },
        { uri: "file:///shared/photo.jpg.pdf", name: "photo.jpg.pdf", mimeType: null },
        { uri: "content://shared/file?name=photo.jpg", name: "file", mimeType: null },
      ],
    });
    expect(preview.images).toEqual([]);
    expect(preview.fileCount).toBe(6);
    expect(preview.fileName).toBeNull();
  });
});
