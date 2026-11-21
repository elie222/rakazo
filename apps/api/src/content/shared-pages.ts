import { SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { throttleKey, windowCounter } from "../http/window-counter.js";
import { readSharedPage } from "./pages.js";

const MINUTE_MS = 60_000;
const READS_PER_IP_PER_MINUTE = 120;

/**
 * Anyone with a share link reads what it opens at `<pathPrefix><token>`, signed out: never
 * indexed, cached or sent on as a referrer. Every token that opens nothing gets the same 404, and
 * nothing here runs tools or models.
 */
export function mountShareLinkRead(
  app: Hono,
  pathPrefix: string,
  clientIp: (c: Context) => string | undefined,
  read: (token: string) => Promise<object | null>,
) {
  const reads = windowCounter(MINUTE_MS);
  app.get(`${pathPrefix}:token`, async (c) => {
    const headers = {
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    };
    if (reads(throttleKey(clientIp(c))) > READS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, { ...headers, "retry-after": "60" });
    }
    // Every reader turns away an empty token with the same 404.
    const shared = await read(c.req.param("token") ?? "");
    if (!shared) return c.json({ error: "Not found" }, 404, headers);
    return c.json(shared, 200, headers);
  });
}

/** Anyone with a page's link reads its current version here. */
export function mountSharedPages(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
) {
  mountShareLinkRead(app, SHARED_PAGE_PATH_PREFIX, clientIp, (token) =>
    readSharedPage(prisma, token),
  );
}
