import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { darkTokens } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const source = path("packages/ui-tokens/assets/BotONE.icon/Assets/botone.png");

// Keep the complete mark centered, matching the shared Icon Composer source.
const portrait = await sharp(source).resize(1024, 1024).png().toBuffer();
async function framed(background: string) {
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background } })
    .composite([{ input: portrait, top: 0, left: 0 }])
    .extract({ left: 0, top: 0, width: 1024, height: 1024 })
    .png()
    .toBuffer();
}
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);
async function roundedCorners(input: Buffer) {
  return sharp(input)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}
const square = await framed(darkTokens.background);
const rounded = await roundedCorners(square);

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
}

// PNG frames in ICO are supported by modern Windows and browser favicon loaders.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index] ?? 0;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

for (const app of ["web", "www"]) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}
await mkdir(path("apps/www/public/brand"), { recursive: true });
await png(rounded, "apps/www/public/brand/rakazo-mark.png", 256);
// The site header shows the mark at 36px; 72px covers 2x screens.
await sharp(rounded)
  .resize(72, 72)
  .webp({ quality: 90 })
  .toFile(path("apps/www/public/brand/rakazo-mark-72.webp"));
await png(rounded, "apps/mobile/assets/favicon.png", 128);
await png(square, "apps/desktop/assets/icon.png", 1024);
await ico(rounded, "apps/desktop/assets/icon.ico", [16, 32, 48, 64, 128, 256]);

// The splash shows the character alone, with no plate, so it sits on either splash colour.
// Keep the existing transparent padding so its visual size stays stable.
await sharp(await roundedCorners(await framed("transparent")))
  .resize(620, 620)
  .extend({ top: 202, bottom: 202, left: 202, right: 202, background: "transparent" })
  .png()
  .toFile(path("apps/mobile/assets/splash-icon.png"));

// Native launchers apply their own mask; keep the Android foreground transparent.
await png(square, "apps/mobile/assets/icon.png", 1024);
await sharp(portrait)
  .resize(820, 820)
  .extend({ top: 102, bottom: 102, left: 102, right: 102, background: "transparent" })
  .png()
  .toFile(path("apps/mobile/assets/adaptive-icon.png"));
await sharp({
  create: { width: 1024, height: 1024, channels: 3, background: darkTokens.background },
})
  .png()
  .toFile(path("apps/mobile/assets/icon-background.png"));
const foregroundAlpha = await sharp(path("apps/mobile/assets/adaptive-icon.png"))
  .extractChannel("alpha")
  .toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } })
  .joinChannel(foregroundAlpha)
  .png()
  .toFile(path("apps/mobile/assets/monochrome-icon.png"));
// The development Dock icon includes the same rounded plate with transparent margins.
await sharp(rounded)
  .resize(824, 824)
  .extend({ top: 100, bottom: 100, left: 100, right: 100, background: "transparent" })
  .png()
  .toFile(path("apps/desktop/assets/icon-macos.png"));

// Android notifications use a white alpha silhouette.
const silhouette = await sharp(path("apps/mobile/assets/monochrome-icon.png"))
  .resize(72, 72)
  .extractChannel("alpha")
  .toBuffer();
await sharp({ create: { width: 72, height: 72, channels: 3, background: "white" } })
  .joinChannel(silhouette)
  .png()
  .toFile(path("apps/mobile/assets/notification-icon.png"));
