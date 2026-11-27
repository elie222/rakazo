import { mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const sources = "packages/ui-tokens/assets/app-icons";

const variants = (await readdir(path(sources)))
  .filter((file) => file.endsWith(".png"))
  .map((file) => ({ id: file.slice(0, -4), square: path(`${sources}/${file}`) }));
const icons = [{ id: "default", square: path("apps/mobile/assets/icon.png") }, ...variants];

// The pre-Tahoe Dock shape: a rounded plate inset from the canvas, with a soft shadow below it.
const MAC_SIZE = 512;
const MAC_PLATE = 412;
const MAC_INSET = (MAC_SIZE - MAC_PLATE) / 2;
const plateMask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_PLATE}" height="${MAC_PLATE}"><rect width="${MAC_PLATE}" height="${MAC_PLATE}" rx="92" fill="white"/></svg>`,
);
const shadow = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_SIZE}" height="${MAC_SIZE}"><rect x="${MAC_INSET}" y="${MAC_INSET + 6}" width="${MAC_PLATE}" height="${MAC_PLATE}" rx="92" fill="black" fill-opacity="0.45"/></svg>`,
  ),
)
  .blur(8)
  .png()
  .toBuffer();

async function macIcon(square: string) {
  const plate = await sharp(square)
    .resize(MAC_PLATE, MAC_PLATE)
    .composite([{ input: plateMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return sharp(shadow)
    .composite([{ input: plate, top: MAC_INSET, left: MAC_INSET }])
    .png()
    .toBuffer();
}

for (const dir of [
  "apps/desktop/assets/app-icons",
  "apps/mobile/assets/app-icons",
  "apps/web/public/app-icons",
]) {
  await mkdir(path(dir), { recursive: true });
}
for (const { id, square } of icons) {
  // The default Dock icon comes from the packaged app; these restore or replace it at runtime.
  const mac =
    id === "default"
      ? await sharp(path("apps/desktop/assets/icon-macos.png")).resize(MAC_SIZE).png().toBuffer()
      : await macIcon(square);
  await sharp(mac).toFile(path(`apps/desktop/assets/app-icons/${id}-macos.png`));
  await sharp(square)
    .resize(256)
    .png()
    .toFile(path(`apps/desktop/assets/app-icons/${id}.png`));
  // iPhone home screen icons top out at 60pt @3x, so 180px is the largest any device draws.
  await sharp(square)
    .resize(180)
    .png()
    .toFile(path(`apps/mobile/assets/app-icons/${id}.png`));
  await sharp(square)
    .resize(128)
    .webp({ quality: 88 })
    .toFile(path(`apps/web/public/app-icons/${id}.webp`));
}
