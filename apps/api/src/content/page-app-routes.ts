import type { ArtifactStore, SecretStore } from "@rakazo/adapter-kit";
import type { PageAppView } from "@rakazo/contracts";
import {
  PAGE_APP_API_PATH,
  PAGE_STATE_MAX_BYTES,
  PageAppAbilitiesBodySchema,
  PageAppStateBodySchema,
} from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError, pageChangesScope, runAsTenant } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "../http/http-body.js";
import { throttleKey, windowCounter } from "../http/window-counter.js";
import type { PageAppAccess } from "./page-apps.js";
import {
  pageAppFromToken,
  pageAppStillInstalled,
  revokePageAppToken,
  setPageAppAbilities,
} from "./page-apps.js";
import { getPageImage, savePageReaderState } from "./page-collaboration.js";
import { getPage } from "./pages.js";

const MINUTE_MS = 60_000;
const REQUESTS_PER_APP_PER_MINUTE = 600;
/** A token is 32 random bytes; this only keeps guesses from loading the database. */
const REQUESTS_PER_IP_PER_MINUTE = 1_200;
const HEARTBEAT_MS = 25_000;
const SMALL_BODY_BYTES = 4 * 1024;

const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export type PageAppRouteDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  webOrigin: string;
  events: ThreadEvents;
};

/**
 * What an installed page app reads and writes, with its own token and nothing else: its page,
 * that page's pictures, its owner's saved values on it, and which abilities the owner approved.
 */
export function mountPageAppRoutes(
  app: Hono,
  deps: PageAppRouteDeps,
  clientIp: (c: Context) => string | undefined,
) {
  const requests = windowCounter(MINUTE_MS);
  const addresses = windowCounter(MINUTE_MS);

  async function withApp(
    c: Context,
    handle: (access: PageAppAccess) => Promise<Response>,
  ): Promise<Response> {
    if (addresses(throttleKey(clientIp(c))) > REQUESTS_PER_IP_PER_MINUTE)
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    const access = await pageAppFromToken(deps.prisma, c.req.header("authorization"));
    if (!access) return c.json({ error: "Unauthorized" }, 401, HEADERS);
    if (requests(access.appId) > REQUESTS_PER_APP_PER_MINUTE)
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    try {
      return await runAsTenant(access.actor, () => handle(access));
    } catch (error) {
      if (error instanceof IsolationError) return c.json({ error: "Not found" }, 404, HEADERS);
      throw error;
    }
  }

  async function jsonBody(c: Context, maxBytes: number): Promise<unknown> {
    const text = await readBoundedBody(c.req.raw, maxBytes);
    if (text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  app.get(PAGE_APP_API_PATH, (c) =>
    withApp(c, async (access) => {
      const page = await getPage(deps, access.actor, { pageId: access.pageId });
      const view: PageAppView = { appId: access.appId, page, approved: access.abilities };
      return c.json(view, 200, HEADERS);
    }),
  );

  app.get(`${PAGE_APP_API_PATH}/images/:imageId`, (c) =>
    withApp(c, async (access) => {
      const requested = Number(c.req.query("version"));
      const version =
        Number.isInteger(requested) && requested > 0
          ? requested
          : (
              await deps.prisma.page.findFirst({
                where: { id: access.pageId, userId: access.actor.userId },
                select: { currentVersion: true },
              })
            )?.currentVersion;
      if (!version) throw new IsolationError();
      const image = await getPageImage(deps, access.actor, {
        pageId: access.pageId,
        version,
        imageId: c.req.param("imageId"),
      });
      return c.json(image, 200, HEADERS);
    }),
  );

  app.put(`${PAGE_APP_API_PATH}/state`, (c) =>
    withApp(c, async (access) => {
      const body = PageAppStateBodySchema.safeParse(
        await jsonBody(c, PAGE_STATE_MAX_BYTES + SMALL_BODY_BYTES),
      );
      if (!body.success) return c.json({ error: "Invalid values" }, 400, HEADERS);
      return c.json(
        await savePageReaderState(deps.prisma, access.actor, access.pageId, body.data.values),
        200,
        HEADERS,
      );
    }),
  );

  app.put(`${PAGE_APP_API_PATH}/abilities`, (c) =>
    withApp(c, async (access) => {
      const body = PageAppAbilitiesBodySchema.safeParse(await jsonBody(c, SMALL_BODY_BYTES));
      if (!body.success) return c.json({ error: "Invalid abilities" }, 400, HEADERS);
      const approved = await setPageAppAbilities(deps.prisma, access.appId, body.data.abilities);
      return c.json({ approved }, 200, HEADERS);
    }),
  );

  app.delete(PAGE_APP_API_PATH, (c) =>
    withApp(c, async (access) => {
      await revokePageAppToken(deps.prisma, access.appId);
      return c.json({ ok: true }, 200, HEADERS);
    }),
  );

  app.get(`${PAGE_APP_API_PATH}/changes`, (c) =>
    withApp(c, async (access) => {
      const follow = deps.events.followSpaceChanges;
      if (!follow) return c.json({ error: "Not found" }, 404, HEADERS);
      const stop = new AbortController();
      const ended = c.req.raw.signal;
      ended.addEventListener("abort", () => stop.abort(), { once: true });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (text: string) => {
            if (!stop.signal.aborted) controller.enqueue(encoder.encode(text));
          };
          const close = () => {
            if (stop.signal.aborted) return;
            stop.abort();
            controller.close();
          };
          // A reconnect is the catch-up, so every stream opens with a signal.
          send("data: changed\n\n");
          void bestEffort(
            "page app change stream",
            (async () => {
              try {
                for await (const _ of follow(pageChangesScope(access.actor.userId), stop.signal))
                  send("data: changed\n\n");
              } finally {
                // A failed subscription ends the stream, so the app reconnects and catches up.
                close();
              }
            })(),
          );
          void bestEffort(
            "page app change heartbeat",
            (async () => {
              try {
                while (!stop.signal.aborted) {
                  await abortableDelay(HEARTBEAT_MS, stop.signal);
                  if (stop.signal.aborted) return;
                  // An uninstall ends the stream within a heartbeat.
                  if (!(await pageAppStillInstalled(deps.prisma, access.appId))) return;
                  send(": heartbeat\n\n");
                }
              } finally {
                close();
              }
            })(),
          );
        },
        cancel() {
          stop.abort();
        },
      });
      return new Response(body, {
        headers: {
          ...HEADERS,
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
        },
      });
    }),
  );
}
