import { renderPageAppIconPng } from "@rakazo/adapters";
import type { Actor, PageSummary, PageWebAppIcon } from "@rakazo/contracts";
import {
  PAGE_WEB_APP_ICONS,
  PAGE_WEB_APP_SPACE_PARAM,
  pageWebAppIconUrl,
  pageWebAppPath,
  pageWebAppUrl,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, runAsTenant } from "@rakazo/db";
import { webDarkTokens } from "@rakazo/ui-tokens";
import type { Context, Hono } from "hono";
import { windowCounter } from "../http/window-counter.js";
import { getPageSummary } from "./pages.js";

const MINUTE_MS = 60_000;
const ICONS_PER_USER_PER_MINUTE = 120;
export const PAGE_APP_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
/** Only an answer the owner was given is kept, briefly, in their own browser. */
const SERVED = { ...PAGE_APP_HEADERS, "cache-control": "private, max-age=300" };

/**
 * What a browser needs to install a page as its own app: a manifest and its icons. Only the
 * page's owner, signed in, reads them; anyone else gets the same 404.
 */
export function mountPageWebApp(
  app: Hono,
  deps: {
    prisma: PrismaClient;
    sessionActor: (request: Request, spaceId?: string | null) => Promise<Actor | null>;
  },
) {
  const iconReads = windowCounter(MINUTE_MS);

  async function withPage(
    c: Context,
    handle: (page: PageSummary, actor: Actor) => Promise<Response>,
  ): Promise<Response> {
    const actor = await deps.sessionActor(c.req.raw, c.req.query(PAGE_WEB_APP_SPACE_PARAM));
    if (!actor) return c.json({ error: "Not found" }, 404, PAGE_APP_HEADERS);
    try {
      const page = await runAsTenant(actor, () =>
        getPageSummary(deps.prisma, actor, c.req.param("pageId") ?? ""),
      );
      return await handle(page, actor);
    } catch (error) {
      if (error instanceof IsolationError)
        return c.json({ error: "Not found" }, 404, PAGE_APP_HEADERS);
      throw error;
    }
  }

  app.get("/api/v1/pages/:pageId/app.webmanifest", (c) =>
    withPage(c, async (page, { spaceId }) => {
      const icon = (file: PageWebAppIcon, purpose: "any" | "maskable") => ({
        src: pageWebAppIconUrl(page.id, file, spaceId),
        sizes: `${PAGE_WEB_APP_ICONS[file].size}x${PAGE_WEB_APP_ICONS[file].size}`,
        type: "image/png",
        purpose,
      });
      const manifest = {
        id: pageWebAppPath(page.id),
        name: page.title,
        short_name: page.title,
        start_url: pageWebAppUrl(page.id, spaceId),
        scope: pageWebAppPath(page.id),
        display: "standalone",
        background_color: webDarkTokens.background,
        theme_color: webDarkTokens.background,
        icons: [
          icon("192", "any"),
          icon("512", "any"),
          icon("maskable-192", "maskable"),
          icon("maskable-512", "maskable"),
        ],
      };
      return c.body(JSON.stringify(manifest), 200, {
        ...SERVED,
        "content-type": "application/manifest+json; charset=utf-8",
      });
    }),
  );

  app.get("/api/v1/pages/:pageId/app-icon/:file", async (c) => {
    const name = c.req.param("file").replace(/\.png$/, "");
    if (!c.req.param("file").endsWith(".png") || !Object.hasOwn(PAGE_WEB_APP_ICONS, name))
      return c.json({ error: "Not found" }, 404, PAGE_APP_HEADERS);
    const { size, maskable } = PAGE_WEB_APP_ICONS[name as PageWebAppIcon];
    return withPage(c, async (page, actor) => {
      if (iconReads(actor.userId) > ICONS_PER_USER_PER_MINUTE)
        return c.json({ error: "Too many requests" }, 429, {
          ...PAGE_APP_HEADERS,
          "retry-after": "60",
        });
      const png = await renderPageAppIconPng(page, size, maskable ? "full" : "plate");
      return c.body(png, 200, { ...SERVED, "content-type": "image/png" });
    });
  });
}
