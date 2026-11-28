import type { PageAppIconPage } from "@rakazo/page-kit/app-icon";

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

/** The page's desktop app icon as SVG. Loaded only when someone installs a page. */
export async function pageAppIconSvg(page: PageAppIconPage): Promise<string> {
  const { pageAppIconSvg } = await import("@rakazo/page-kit/app-icon");
  return pageAppIconSvg(page);
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The icon drawn as PNG at every size an app icon file holds, as base64. */
export async function pageAppIconPngs(svg: string): Promise<{ size: number; png: string }[]> {
  const image = new Image();
  image.src = svgDataUrl(svg);
  await image.decode();
  return SIZES.map((size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the app icon.");
    context.drawImage(image, 0, 0, size, size);
    return { size, png: canvas.toDataURL("image/png").slice("data:image/png;base64,".length) };
  });
}
