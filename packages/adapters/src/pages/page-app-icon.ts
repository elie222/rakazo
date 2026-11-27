import type { PageAppIconPage, PageAppIconShape } from "@rakazo/page-kit/app-icon";

/** The page's app icon as a PNG square of `size` pixels. */
export async function renderPageAppIconPng(
  page: PageAppIconPage,
  size: number,
  shape: PageAppIconShape,
): Promise<Uint8Array<ArrayBuffer>> {
  const [{ pageAppIconSvg }, { default: sharp }] = await Promise.all([
    import("@rakazo/page-kit/app-icon"),
    import("sharp"),
  ]);
  const png = await sharp(Buffer.from(pageAppIconSvg(page, shape)), { density: (72 * size) / 1024 })
    .resize(size, size)
    .png()
    .toBuffer();
  return Uint8Array.from(png);
}
