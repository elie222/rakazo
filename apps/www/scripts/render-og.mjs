import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ogPages } from "../src/og-pages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/og");
const chrome = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

function pageHtml(kicker, title) {
  const fontSize = title.length > 72 ? 40 : 68;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 1200px; height: 630px; background: #fdfdfd; }
    body { font-family: Geist, ui-sans-serif, system-ui, sans-serif; color: #242424; }
    .card { box-sizing: border-box; width: 1200px; height: 630px; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between; }
    .kicker { margin: 0; color: #6d6e70; font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 18px 0 0; max-width: 980px; font-size: ${fontSize}px; line-height: 1.05; font-weight: 560; letter-spacing: -0.03em; }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div>
      <p class="kicker">${kicker}</p>
      <h1>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</h1>
    </div>
    <div class="brand">
      <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#2965EC" d="M8 62c0-13 6-17 10-24 5-8 2-15 8-22 5-6 12-7 18-2 4 3 7 1 11 4 6 5 4 13 0 19-3 5 3 10 4 17 1 4-1 7-4 8H8Z"/>
        <rect x="28" y="24" width="5" height="10" rx="2.5" fill="#F2F2F0"/>
        <rect x="38" y="24" width="5" height="10" rx="2.5" fill="#F2F2F0"/>
        <circle cx="52" cy="51" r="5" fill="#3EC5A8"/>
      </svg>
      Rakazo
    </div>
  </div>
</body>
</html>`;
}

mkdirSync(outDir, { recursive: true });
const tmp = join(outDir, ".og-render.html");

const selected = new Set(process.argv.slice(2));
const pages = ogPages().filter((page) => selected.size === 0 || selected.has(page.id));

try {
  for (const page of pages) {
    writeFileSync(tmp, pageHtml(page.kicker, page.title));
    const target = join(outDir, `${page.id}.png`);
    const result = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1200,630",
        "--default-background-color=00000000",
        `--screenshot=${target}`,
        `file://${tmp}`,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`Open Graph render failed for ${page.id} with status ${result.status ?? 1}`);
    }
    console.log(page.id);
  }
} finally {
  if (existsSync(tmp)) unlinkSync(tmp);
}
