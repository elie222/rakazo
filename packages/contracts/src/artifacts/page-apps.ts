import * as z from "zod";
import { Id } from "../ids.js";
import { PageAbilitiesSchema } from "./page-abilities.js";
import { PageStateSchema } from "./page-reader-state.js";
import { PageDetailSchema, PageIconColorSchema } from "./pages.js";

/** Where an installed page app reads its page, with its own token as a bearer credential. */
export const PAGE_APP_API_PATH = "/api/v1/page-app";
export const PAGE_APP_TOKEN_PREFIX = "rkpa_";
/** The prefix and 32 random bytes as base64url. */
export const PAGE_APP_TOKEN = /^rkpa_[A-Za-z0-9_-]{43}$/;

/** What an installed app reads on start and after each change signal. */
export const PageAppViewSchema = z.strictObject({
  appId: Id,
  page: PageDetailSchema,
  /** Abilities the person approved for this app; the page's own list says what it uses. */
  approved: PageAbilitiesSchema,
});
export type PageAppView = z.infer<typeof PageAppViewSchema>;

export const PageAppStateBodySchema = z.strictObject({ values: PageStateSchema });
export const PageAppAbilitiesBodySchema = z.strictObject({ abilities: PageAbilitiesSchema });

export const PageAppInstallInputSchema = z.strictObject({
  pageId: Id,
  abilities: PageAbilitiesSchema,
});

export const PageAppInstallSchema = z.strictObject({
  appId: Id,
  /** Shown once: only its hash is kept. */
  token: z.string().regex(PAGE_APP_TOKEN),
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: PageIconColorSchema.nullable(),
});
export type PageAppInstall = z.infer<typeof PageAppInstallSchema>;

/** Where a page opens on its own in a browser, which a browser can install as an app. */
export function pageWebAppPath(pageId: string): string {
  return `/page/${encodeURIComponent(pageId)}`;
}

/** The Space a page web app reads from, carried on its links since an installed app has no picker. */
export const PAGE_WEB_APP_SPACE_PARAM = "space";

function inSpace(path: string, spaceId: string | null): string {
  return spaceId ? `${path}?${PAGE_WEB_APP_SPACE_PARAM}=${encodeURIComponent(spaceId)}` : path;
}

export function pageWebAppUrl(pageId: string, spaceId: string | null): string {
  return inSpace(pageWebAppPath(pageId), spaceId);
}

export function pageWebAppManifestUrl(pageId: string, spaceId: string | null): string {
  return inSpace(`/api/v1/pages/${encodeURIComponent(pageId)}/app.webmanifest`, spaceId);
}

/** Icon files a page web app has: a touch icon at 180, and launcher icons with and without a mask. */
export const PAGE_WEB_APP_ICONS = {
  "180": { size: 180, maskable: true },
  "192": { size: 192, maskable: false },
  "512": { size: 512, maskable: false },
  "maskable-192": { size: 192, maskable: true },
  "maskable-512": { size: 512, maskable: true },
} as const;
export type PageWebAppIcon = keyof typeof PAGE_WEB_APP_ICONS;

export function pageWebAppIconUrl(
  pageId: string,
  icon: PageWebAppIcon,
  spaceId: string | null,
): string {
  return inSpace(`/api/v1/pages/${encodeURIComponent(pageId)}/app-icon/${icon}.png`, spaceId);
}
