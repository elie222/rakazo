import type { createCompanyOsWorkforce } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

export function mountWorkforceRoutes(
  app: Hono,
  workforce: ReturnType<typeof createCompanyOsWorkforce>,
  authenticate: (c: Context) => Promise<Actor | null>,
  webOrigin: string,
) {
  app.get("/api/v1/workforce", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ connection: await workforce.status(actor) });
  });
  app.put("/api/v1/workforce", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header("origin") !== new URL(webOrigin).origin)
      return c.json({ error: "Invalid origin" }, 403);
    const raw = await readBoundedBody(c.req.raw, 96 * 1024);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    try {
      await workforce.configure(actor, JSON.parse(raw));
      return c.json({ connection: await workforce.status(actor) });
    } catch {
      return c.json(
        {
          error:
            "Could not configure workforce. Check the endpoint, key, model IDs, and active assignments.",
        },
        400,
      );
    }
  });
  app.patch("/api/v1/workforce", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header("origin") !== new URL(webOrigin).origin)
      return c.json({ error: "Invalid origin" }, 403);
    const raw = await readBoundedBody(c.req.raw, 1024);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    let body: { enabled?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (typeof body?.enabled !== "boolean")
      return c.json({ error: "enabled must be a boolean" }, 400);
    await workforce.setEnabled(actor, body.enabled);
    return c.json({ connection: await workforce.status(actor) });
  });
}
