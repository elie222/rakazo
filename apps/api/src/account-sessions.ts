import type { Auth } from "@rakazo/auth";
import type { AccountNotification, AccountSessions, SavedAccountSummary } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { isBackgroundRunTrigger, truncatedPlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { requestClientIp, withClientIp } from "./client-ip.js";
import { readBoundedBody } from "./http-body.js";

/** Reject stale pages before any handler can reuse their body under a replacement cookie. */
export function mountAccountIdentityGuard(
  app: Hono,
  sessionUserId: (request: Request) => Promise<string | null>,
) {
  app.use("*", async (c, next) => {
    const expected = c.req.header("x-rakazo-user-id");
    if (expected && expected !== (await sessionUserId(c.req.raw)))
      return c.json({ error: "Account changed" }, 401);
    await next();
  });
}

/** Reads only owned inbox chats in Spaces where this account still has membership. */
async function accountActivity(prisma: PrismaClient, userId: string) {
  return runAsSystem("read saved account notification summaries", async () => {
    const [count] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count FROM threads t
      WHERE t."userId" = ${userId} AND t.unread AND t."externalConversationId" IS NULL
        AND EXISTS (SELECT 1 FROM space_members m WHERE m."spaceId" = t."spaceId" AND m."userId" = ${userId})
        AND (
          EXISTS (SELECT 1 FROM bots b WHERE b.id = t."botId" AND b."spaceId" = t."spaceId" AND b."userId" = ${userId} AND b."archivedAt" IS NULL)
          OR EXISTS (SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."spaceId" = t."spaceId" AND g."userId" = ${userId} AND g."archivedAt" IS NULL
            AND (SELECT count(*) FROM chat_group_members gm JOIN bots b ON b.id = gm."botId" WHERE gm."groupId" = g.id AND b."archivedAt" IS NULL) >= ${GROUP_MEMBER_MIN})
        )`);
    const memberships = await prisma.spaceMember.findMany({
      where: { userId },
      select: { spaceId: true },
    });
    const spaceIds = memberships.map((member) => member.spaceId);
    if (!spaceIds.length) return { unread: count?.count ?? 0, notifications: [] };
    const notifications: AccountNotification[] = [];
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    let before: { createdAt: Date; id: string } | undefined;
    while (notifications.length < 50) {
      const events = await prisma.event.findMany({
        where: {
          spaceId: { in: spaceIds },
          thread: { userId, externalConversationId: null },
          type: {
            in: [
              "thread.message.created",
              "run.failed",
              "run.waiting_input",
              "computer.takeover.requested",
            ],
          },
          createdAt: { gt: since },
          ...(before
            ? {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: {
          thread: {
            select: {
              bot: { select: { name: true, userId: true, archivedAt: true, notifyOnFinish: true } },
              group: {
                select: {
                  id: true,
                  name: true,
                  userId: true,
                  archivedAt: true,
                  members: { where: { bot: { archivedAt: null } }, select: { id: true } },
                },
              },
            },
          },
        },
      });
      if (!events.length) break;
      const runIds = [...new Set(events.flatMap((event) => (event.runId ? [event.runId] : [])))];
      const runs = await prisma.run.findMany({
        where: { id: { in: runIds }, userId, spaceId: { in: spaceIds } },
        select: { id: true, trigger: true, status: true, routine: { select: { notify: true } } },
      });
      const byRun = new Map(runs.map((run) => [run.id, run]));
      for (const event of events) {
        const { bot, group } = event.thread;
        if (
          group
            ? group.userId !== userId || group.archivedAt || group.members.length < GROUP_MEMBER_MIN
            : !bot || bot.userId !== userId || bot.archivedAt
        )
          continue;
        const run = event.runId ? byRun.get(event.runId) : undefined;
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload
            : {};
        const message = event.type === "thread.message.created";
        if (message && payload.role !== "bot") continue;
        if (message && (run?.status === "waiting_input" || run?.status === "waiting_takeover"))
          continue;
        const kind = message
          ? "completion"
          : event.type === "run.failed"
            ? "failure"
            : event.type === "run.waiting_input"
              ? "help"
              : "takeover";
        if (run && isBackgroundRunTrigger(run.trigger) && kind !== "help" && kind !== "takeover")
          continue;
        const enabled =
          kind === "failure" && run?.routine
            ? run.routine.notify
            : Boolean(group || bot?.notifyOnFinish);
        if (!enabled) continue;
        const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
        const text = blocks
          .flatMap((block) =>
            block && typeof block === "object" && "text" in block && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("\n");
        const name = group?.name ?? bot?.name ?? "Bot";
        const attention =
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.reason === "string"
              ? payload.reason
              : kind === "help"
                ? `${name} needs an answer`
                : kind === "takeover"
                  ? `${name} needs you on the screen`
                  : `${name} failed`;
        notifications.push({
          id: event.id,
          kind,
          title: group?.name ?? bot?.name ?? "",
          body: truncatedPlainText(message ? text : text || attention, 180),
          botId: event.botId,
          threadId: event.threadId,
          spaceId: event.spaceId,
          ...(group ? { groupId: group.id } : {}),
        });
        if (notifications.length >= 50) break;
      }
      if (events.length < 100) break;
      const last = events.at(-1)!;
      before = { createdAt: last.createdAt, id: last.id };
    }
    return { unread: count?.count ?? 0, notifications };
  });
}

export function mountAccountSessions(
  app: Hono,
  deps: {
    auth: Auth;
    prisma: PrismaClient;
    trustedOrigin: (origin: string) => boolean;
    handleAuthRequest?: (request: Request, ip: string | undefined) => Promise<Response>;
    serverOrigin?: string;
  },
) {
  app.use("/api/accounts*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.get("/api/accounts", async (c) => {
    const { auth, prisma } = deps;
    const headers = new Headers(c.req.raw.headers);
    if (headers.has("authorization")) headers.delete("cookie");
    const [active, saved] = await runAsSystem("authenticate saved account summary request", () =>
      Promise.all([auth.api.getSession({ headers }), auth.api.listSavedAccounts({ headers })]),
    );
    const current = active
      ? {
          userId: active.user.id,
          sessionId: active.session.id,
          name: active.user.name,
          email: active.user.email,
          image: active.user.image ?? null,
        }
      : null;
    // Native bearer requests select exactly that identity even if an HTTP host also attaches cookies.
    const proven = c.req.header("authorization") ? (current ? [current] : []) : saved;
    if (
      !c.req.header("authorization") &&
      current &&
      !proven.some((account) => account.userId === current.userId)
    )
      proven.unshift(current);
    const accounts = await Promise.all(
      proven.map(
        async (account) =>
          ({
            ...account,
            ...(await accountActivity(prisma, account.userId)),
          }) satisfies SavedAccountSummary,
      ),
    );
    return c.json({
      activeUserId: active?.user.id ?? null,
      accounts,
      ...(deps.serverOrigin ? { serverOrigin: deps.serverOrigin } : {}),
    } satisfies AccountSessions);
  });
  for (const action of ["select", "remove"] as const) {
    app.post(`/api/accounts/${action}`, async (c) => {
      const origin = c.req.header("origin");
      if (!origin || !deps.trustedOrigin(origin)) return c.json({ error: "Forbidden" }, 403);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "Expected JSON" }, 415);
      const body = await readBoundedBody(c.req.raw, 4096);
      if (body === null) return c.json({ error: "Request too large" }, 413);
      const url = new URL(c.req.url);
      url.pathname = `/api/auth/accounts/${action}`;
      const ip = requestClientIp(c);
      const request = withClientIp(
        new Request(url, {
          method: "POST",
          headers: c.req.raw.headers,
          body,
        }),
        ip,
      );
      return runAsSystem("select or remove a saved account session", () =>
        deps.handleAuthRequest ? deps.handleAuthRequest(request, ip) : deps.auth.handler(request),
      );
    });
  }
}
