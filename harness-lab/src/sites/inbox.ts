import { Hono } from "hono";
import { buildFixtures } from "../fixtures.js";
import { esc, type Lab, type LabConfig, type SiteId } from "../lib/core.js";
import { page } from "../lib/ui.js";

/** Fake SMS/email inbox plus the lab runner's control and event-log API. */
export function inboxSite(lab: Lab): Hono {
  const app = new Hono();

  // Everything here, the page included, needs the lab token. Without it the port looks like it
  // serves nothing (404, not 401) and the attempt is logged, since a bot should never come here.
  app.use("*", async (c, next) => {
    const token = lab.options.token;
    if (!token) return next();
    const url = new URL(c.req.url);
    const given = c.req.header("x-lab-token") ?? url.searchParams.get("token");
    if (given === token) return next();
    lab.log("inbox", "inbox.probe", {
      method: c.req.method,
      path: url.pathname,
      source:
        (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
          ?.socket?.remoteAddress ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.notFound();
  });

  const filter = (q: Record<string, string | undefined>) =>
    lab.messages.filter(
      (m) =>
        (!q.to || m.to === q.to) &&
        (!q.site || m.site === q.site) &&
        (!q.channel || m.channel === q.channel),
    );

  app.get("/api/health", (c) => c.json({ ok: true, now: lab.now() }));
  app.get("/api/messages", (c) => c.json({ messages: filter(c.req.query()) }));
  app.get("/api/latest-code", (c) => {
    const last = filter(c.req.query())
      .filter((m) => m.code)
      .at(-1);
    return last ? c.json({ code: last.code, message: last }) : c.json({ error: "no code" }, 404);
  });
  app.get("/api/events", (c) => {
    const { site, type, since } = c.req.query();
    const events = lab.events.filter(
      (e) =>
        (!site || e.site === site) &&
        (!type || e.type === type) &&
        (!since || e.seq > Number(since)),
    );
    return c.json({ events });
  });
  app.get("/api/fixtures", (c) => c.json(buildFixtures()));
  app.get("/api/config", (c) => c.json(lab.config));
  app.post("/api/config", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      pension?: Partial<LabConfig["pension"]>;
    };
    const next = { ...lab.config.pension, ...body.pension };
    if (
      !["iframe", "inline"].includes(next.login) ||
      typeof next.otp !== "boolean" ||
      typeof next.html !== "boolean" ||
      !["single", "slots", "split"].includes(next.otpWidget)
    ) {
      return c.json({ error: "invalid config" }, 400);
    }
    lab.config.pension = next;
    lab.log("inbox", "config.changed", { pension: next });
    return c.json(lab.config);
  });
  app.post("/api/reset", (c) => {
    lab.reset();
    return c.json({ ok: true });
  });
  app.post("/api/clock/advance", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ms?: number };
    lab.advanceClock(Number(body.ms ?? 0));
    return c.json({ ok: true, now: lab.now() });
  });

  app.get("/", (c) => {
    const to = c.req.query("to") ?? "";
    const msgs = filter({ to: to || undefined })
      .slice()
      .reverse();
    const rows = msgs
      .map(
        (m) => `<tr data-testid="message"><td>${new Date(m.at).toISOString().slice(11, 19)}</td>
<td>${m.channel === "sms" ? "SMS" : "Email"}</td><td dir="ltr">${esc(m.to)}</td><td>${esc(m.site)}</td>
<td>${esc(m.body)}</td></tr>`,
      )
      .join("");
    return c.html(
      page(
        { title: "Lab inbox", lang: "en" },
        `<header class="top"><strong>Lab inbox</strong><span>simulated SMS and email</span></header><main>
<form class="card">${c.req.query("token") ? `<input type="hidden" name="token" value="${esc(c.req.query("token"))}">` : ""}<label for="to">Phone number or email</label>
<input id="to" name="to" value="${esc(to)}" placeholder="0555000101"> <button>Show</button></form>
<table><thead><tr><th>Time</th><th>Type</th><th>To</th><th>From site</th><th>Message</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">No messages</td></tr>'}</tbody></table></main>`,
      ),
    );
  });

  return app;
}

export type { SiteId };
