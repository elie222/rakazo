import { SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { throttleKey, windowCounter } from "../http/window-counter.js";
import { readSharedPage, readSharedPageImage } from "./pages.js";

const MINUTE_MS = 60_000;
const READS_PER_IP_PER_MINUTE = 120;
const IMAGE_READS_PER_IP_PER_MINUTE = 1200;

const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/**
 * Anyone with a page's link reads its current version here, signed out. Every token that does
 * not open a shared page gets the same 404, and nothing here runs tools or models.
 */
export function mountSharedPages(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
) {
  const reads = windowCounter(MINUTE_MS);
  const imageReads = windowCounter(MINUTE_MS);
  app.get(`${SHARED_PAGE_PATH_PREFIX}:token`, async (c) => {
    if (reads(throttleKey(clientIp(c))) > READS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    }
    const page = await readSharedPage(prisma, c.req.param("token"));
    if (!page) return c.json({ error: "Not found" }, 404, HEADERS);
    return c.json(page, 200, HEADERS);
  });
  app.get(`${SHARED_PAGE_PATH_PREFIX}:token/images/:imageId`, async (c) => {
    if (imageReads(throttleKey(clientIp(c))) > IMAGE_READS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    }
    const image = await readSharedPageImage(prisma, c.req.param("token"), c.req.param("imageId"));
    if (!image) return c.json({ error: "Not found" }, 404, HEADERS);
    return c.json(image, 200, HEADERS);
  });
}
