// Tells IndexNow (Bing, Yandex and other engines) which pages changed since the previous
// production deploy, read from the live sitemap's <lastmod>. Best-effort: network and HTTP
// failures are reported as warnings and do not fail the run.
//
// Usage: node apps/www/scripts/indexnow.mjs <since ISO timestamp>
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://rakazo.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH_SIZE = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

class HttpError extends Error {}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

// The key is the name of its file in public/, so it lives in one place.
function indexNowKey() {
  const keys = readdirSync(publicDir).flatMap(
    (file) => /^([0-9a-f]{32})\.txt$/.exec(file)?.[1] ?? [],
  );
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
function parseSitemap(xml) {
  return {
    sitemaps: entries(xml, "sitemap").map((entry) => entry.loc),
    urls: entries(xml, "url"),
  };
}

/**
 * Pages on the site whose lastmod is after `since`; pages without a lastmod are left out.
 * A date-only lastmod counts from the start of `since`'s day, so a page edited later that day
 * is kept.
 */
function changedSince(urls, since) {
  const cutoff = since.getTime();
  const dayCutoff = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  return urls.flatMap(({ loc, lastmod }) => {
    if (!lastmod || !onSite(loc)) return [];
    const modified = Date.parse(lastmod);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(lastmod);
    return (dateOnly ? modified >= dayCutoff : modified > cutoff) ? [loc] : [];
  });
}

function onSite(url) {
  if (!URL.canParse(url)) return false;
  const { protocol, host } = new URL(url);
  return protocol === "https:" && host === new URL(SITE).host;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new HttpError(`GET ${url} answered ${response.status}`);
  return response.text();
}

async function sitemapUrls() {
  const index = parseSitemap(await fetchText(`${SITE}/sitemap-index.xml`));
  const children = await Promise.all(
    index.sitemaps.filter(onSite).map(async (loc) => parseSitemap(await fetchText(loc)).urls),
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    if (response.status === 200 || response.status === 202) {
      console.log(`IndexNow accepted ${batch.length} URLs (${response.status}).`);
    } else {
      console.log(`::warning::IndexNow answered ${response.status}: ${body.slice(0, 500)}`);
    }
  }
}

// Network and HTTP failures are best-effort; anything else is a bug and fails the run.
async function skipOnNetworkError(label, work) {
  try {
    return await work();
  } catch (error) {
    // Node's fetch reports network failures as a TypeError with the underlying cause.
    const network =
      (error instanceof TypeError && error.cause !== undefined) || error?.name === "TimeoutError";
    if (!network && !(error instanceof HttpError)) throw error;
    console.log(`::warning::${label} skipped: ${error.cause?.message ?? error.message}`);
    return undefined;
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
  const urls = await skipOnNetworkError("Reading the sitemap", sitemapUrls);
  if (!urls) return;
  if (!urls.some((url) => url.lastmod)) {
    console.log("The sitemap has no <lastmod>, so nothing is submitted.");
    return;
  }
  const changed = changedSince(urls, since);
  if (changed.length === 0) {
    console.log(`No pages changed since ${since.toISOString()}.`);
    return;
  }
  await skipOnNetworkError("IndexNow ping", () => submit(changed, key));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
