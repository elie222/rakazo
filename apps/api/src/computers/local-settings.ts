import { timingSafeEqual } from "node:crypto";
import { sandboxKindCapabilities } from "@rakazo/adapters";
import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Hono } from "hono";
import { parse } from "hono/utils/cookie";
import { readBoundedBody } from "../http/http-body.js";

export function validLocalSettingsToken(
  expected: string | undefined,
  supplied: string | undefined,
): boolean {
  return Boolean(
    expected &&
      supplied &&
      /^[a-f0-9]{64}$/.test(expected) &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)),
  );
}

/** Accepts a signup only from the desktop app's own window, the one place its cookie is set. */
export function localSignupAdmitter(stackToken: string) {
  const expected = localSignupKey(stackToken);
  return (headers: Headers | undefined) =>
    validLocalSettingsToken(
      expected,
      parse(headers?.get("cookie") ?? "", LOCAL_SIGNUP_COOKIE)[LOCAL_SIGNUP_COOKIE],
    );
}

/** Native host choice uses a local OS capability, never an app account. */
export function mountLocalComputerHost(
  app: Hono,
  deps: {
    token?: string;
    sandboxProvider?: string;
    prisma: PrismaClient;
  },
) {
  const offersHostComputer = sandboxKindCapabilities(deps.sandboxProvider).offersHostComputer;
  // A choice saved under an earlier provider would hand new bots a computer nothing can run.
  if (!offersHostComputer) {
    void bestEffort(
      "clear a host computer choice this provider cannot offer",
      runAsSystem("clear an unavailable computer host choice", () =>
        deps.prisma.deploymentSettings.updateMany({
          where: { computerHost: "this-mac" },
          data: { computerHost: null },
        }),
      ),
    );
  }
  // Only the native main process holds this token. Public sessions never authorize this route.
  app.post(LOCAL_COMPUTER_HOST_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(deps.token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER))) {
      return c.json({ error: "Local settings are unavailable" }, 401);
    }
    if (!offersHostComputer) return c.json({ error: "Unavailable" }, 403);
    const body = await readBoundedBody(c.req.raw, 1024);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    let computerHost: unknown;
    try {
      computerHost = JSON.parse(body).computerHost;
    } catch {
      /* invalid JSON */
    }
    if (computerHost !== "docker" && computerHost !== "this-mac") {
      return c.json({ error: "Invalid computer host" }, 400);
    }
    const selected = computerHost;
    await runAsSystem("locally authorized computer host choice", () =>
      deps.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", computerHost: selected },
        update: { computerHost: selected },
      }),
    );
    return c.json({ ok: true });
  });
  // Old native clients must fail closed rather than select a profile implicitly.
  app.all("/api/desktop-settings/rpc/*", (c) => c.json({ error: "Unavailable" }, 403));
}
