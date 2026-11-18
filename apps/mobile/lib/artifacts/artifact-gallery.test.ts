import { describe, expect, it } from "vitest";
import {
  galleryIndex,
  isMediaArtifact,
  mediaArtifactGallery,
  parseArtifactGallery,
} from "./artifact-gallery";

const list = [
  { id: "image-a", name: "chart.png", mimeType: "image/png" },
  { id: "notes", name: "notes.md", mimeType: "text/markdown" },
  { id: "video", name: "demo.mp4", mimeType: "video/mp4" },
  { id: "image-b", name: "photo.jpg", mimeType: "image/jpeg" },
];

describe("mediaArtifactGallery", () => {
  it("keeps only images and videos in list order", () => {
    expect(mediaArtifactGallery(list).map((item) => item.id)).toEqual([
      "image-a",
      "video",
      "image-b",
    ]);
  });

  it("drops duplicate families and unknown or preview-less types", () => {
    expect(
      mediaArtifactGallery([
        ...list,
        { id: "image-a", name: "chart copy.png", mimeType: "image/png" },
        { id: "zip", name: "bundle.zip", mimeType: "application/zip" },
      ]).map((item) => item.id),
    ).toEqual(["image-a", "video", "image-b"]);
  });

  it("treats every supported image type and mp4 as media", () => {
    expect(isMediaArtifact({ mimeType: "image/webp" })).toBe(true);
    expect(isMediaArtifact({ mimeType: "video/mp4" })).toBe(true);
    expect(isMediaArtifact({ mimeType: "application/pdf" })).toBe(false);
    expect(isMediaArtifact({ mimeType: "text/plain" })).toBe(false);
  });
});

describe("parseArtifactGallery", () => {
  it("reads a route param and drops entries that are not media", () => {
    const encoded = JSON.stringify([
      ...list,
      { id: "", name: "empty", mimeType: "image/png" },
      { id: "missing-name", mimeType: "image/png" },
    ]);
    expect(parseArtifactGallery(encoded).map((item) => item.id)).toEqual([
      "image-a",
      "video",
      "image-b",
    ]);
  });

  it("accepts the first value when a deep link repeats the param", () => {
    const encoded = JSON.stringify(list.slice(0, 1));
    expect(parseArtifactGallery([encoded, "ignored"]).map((item) => item.id)).toEqual(["image-a"]);
  });

  it("ignores malformed, empty and non-array values", () => {
    expect(parseArtifactGallery(undefined)).toEqual([]);
    expect(parseArtifactGallery("")).toEqual([]);
    expect(parseArtifactGallery("not json")).toEqual([]);
    expect(parseArtifactGallery(JSON.stringify({ id: "image-a" }))).toEqual([]);
  });
});

describe("gallery navigation", () => {
  const gallery = mediaArtifactGallery(list);

  it("finds the current page", () => {
    expect(galleryIndex(gallery, "video")).toBe(1);
    expect(galleryIndex(gallery, "notes")).toBe(-1);
  });
});
