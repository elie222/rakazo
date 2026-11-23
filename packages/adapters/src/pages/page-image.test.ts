import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePageImage } from "./page-image.js";

describe("encodePageImage", () => {
  it("redraws a large photo as a smaller WebP without its metadata", async () => {
    const photo = await sharp({
      create: { width: 3200, height: 1600, channels: 3, background: "#336699" },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "fixture" } } })
      .toBuffer();
    const encoded = await encodePageImage(photo);
    if (typeof encoded === "string") throw new Error(encoded);
    expect(encoded).toMatchObject({ mimeType: "image/webp", width: 1600, height: 800 });
    const stored = await sharp(Buffer.from(encoded.data, "base64")).metadata();
    expect(stored).toMatchObject({ format: "webp", width: 1600, height: 800 });
    expect(stored.exif).toBeUndefined();
  });

  it("refuses anything that is not a raster picture", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(await encodePageImage(svg)).toBe("only PNG, JPEG, GIF or WebP pictures can be shown");
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(await encodePageImage(broken)).toBe("the picture could not be read");
  });
});
