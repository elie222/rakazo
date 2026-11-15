// Tells IndexNow (Bing, Yandex and other engines) which pages changed since the previous
// production deploy, read from the live sitemap's <lastmod>. Best-effort: problems are
// reported as warnings and never fail the run.
//
// Usage: node apps/www/scripts/indexnow.mjs <since ISO timestamp>
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://rakazo.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH_SIZE = 10_000;

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

// The key is the name of its file in public/, so it lives in one place.
export function indexNowKey(files = readdirSync(publicDir)) {
  const keys = files.flatMap((file) => /^([0-9a-f]{32})\.txt$/.exec(file)?.[1] ?? []);
  if (keys.length !== 1) throw new Error(`Expected one IndexNow key file, found ${keys.length}`);
  return keys[0];
}

function tag(block, name) {
  const value = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)?.[1];
  return value
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function entries(xml, element) {
  return [...xml.matchAll(new RegExp(`<${element}>([\\s\\S]*?)</${element}>`, "g"))].flatMap(
    ([, block]) => {
      const loc = tag(block, "loc");
      return loc ? [{ loc, lastmod: tag(block, "lastmod") }] : [];
    },
  );
}

/** Child sitemaps of a sitemap index and pages of a urlset; a document has one or the other. */
export function parseSitemap(xml) {
  return {
    sitemaps: entries(xml, "sitemap").map((entry) => entry.loc),
    urls: entries(xml, "url"),
  };
}

/** Pages on the site whose lastmod is after `since`; pages without a lastmod are left out. */
export function changedSince(urls, since) {
  const cutoff = since.getTime();
  const { host } = new URL(SITE);
  return urls.flatMap(({ loc, lastmod }) => {
    const modified = lastmod ? Date.parse(lastmod) : Number.NaN;
    if (!(modified > cutoff) || new URL(loc).host !== host) return [];
    return [loc];
  });
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.text();
}

async function sitemapUrls() {
  const index = parseSitemap(await fetchText(`${SITE}/sitemap-index.xml`));
  const children = await Promise.all(
    index.sitemaps.map(async (loc) => parseSitemap(await fetchText(loc)).urls),
  );
  return [...index.urls, ...children.flat()];
}

async function submit(urlList, key) {
  const { host } = new URL(SITE);
  for (let start = 0; start < urlList.length; start += BATCH_SIZE) {
    const batch = urlList.slice(start, start + BATCH_SIZE);
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `${SITE}/${key}.txt`, urlList: batch }),
    });
    if (response.status === 200 || response.status === 202) {
      console.log(`IndexNow accepted ${batch.length} URLs (${response.status}).`);
    } else {
      const body = await response.text().catch(() => "");
      console.log(`::warning::IndexNow answered ${response.status}: ${body.slice(0, 500)}`);
    }
  }
}

async function main(sinceArg) {
  const since = new Date(sinceArg ?? "");
  if (Number.isNaN(since.getTime())) {
    console.error("Usage: node apps/www/scripts/indexnow.mjs <since ISO timestamp>");
    process.exitCode = 1;
    return;
  }
  const key = indexNowKey();
  try {
    const urls = await sitemapUrls();
    if (!urls.some((url) => url.lastmod)) {
      console.log("The sitemap has no <lastmod>, so nothing is submitted.");
      return;
    }
    const changed = changedSince(urls, since);
    if (changed.length === 0) {
      console.log(`No pages changed since ${since.toISOString()}.`);
      return;
    }
    await submit(changed, key);
  } catch (error) {
    console.log(`::warning::IndexNow ping skipped: ${error.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
