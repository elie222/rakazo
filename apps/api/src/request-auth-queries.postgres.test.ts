import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSystem, createDb } from "@rakazo/db";
import { expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const AUTH_TABLE = /FROM "public"\."(session|user|member|space_members)"/;

it.skipIf(!databaseUrl)(
  "authorizes a signed-in request with one session, user and membership read, and still refuses revoked access",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-request-auth-"));
    const db = createDb(databaseUrl!);
    // Only this request's reads, not background work its signup started.
    const counted = new AsyncLocalStorage<string[]>();
    const query = db.pool.query.bind(db.pool) as (...args: unknown[]) => unknown;
    db.pool.query = ((...args: unknown[]) => {
      const [config] = args;
      const text = typeof config === "string" ? config : (config as { text?: string }).text;
      const table = text?.match(AUTH_TABLE)?.[1];
      if (table) counted.getStore()?.push(table);
      return query(...args);
    }) as typeof db.pool.query;
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      prisma: db.prisma,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    const system = asSystem(db.prisma);
    try {
      const signUp = async (email: string) => {
        const response = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email, password: "test-password-123", name: "Auth reads" }),
        });
        expect(response.status).toBeLessThan(400);
        return sessionCookieHeader(response);
      };
      const call = (cookie: string, procedure = "bots/list") =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json: {} }),
        });
      const stamp = Date.now();
      const email = `request-auth-${stamp}@example.test`;
      const cookie = await signUp(email);
      // The first request pins the session to an organization.
      expect((await call(cookie)).status).toBe(200);

      const authReads: string[] = [];
      expect((await counted.run(authReads, () => call(cookie))).status).toBe(200);
      expect(authReads.sort()).toEqual(["session", "space_members", "user"]);

      const user = await system.user.findUniqueOrThrow({ where: { email } });
      await system.spaceMember.deleteMany({ where: { userId: user.id } });
      expect((await call(cookie)).status).toBe(401);

      const deactivatedEmail = `request-auth-deactivated-${stamp}@example.test`;
      const deactivatedCookie = await signUp(deactivatedEmail);
      expect((await call(deactivatedCookie)).status).toBe(200);
      await system.user.update({
        where: { email: deactivatedEmail },
        data: { deactivatedAt: new Date() },
      });
      expect((await call(deactivatedCookie)).status).toBe(401);

      const signedOutCookie = await signUp(`request-auth-signed-out-${stamp}@example.test`);
      expect((await call(signedOutCookie)).status).toBe(200);
      const signOut = await handles.app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: signedOutCookie, origin },
      });
      expect(signOut.status).toBe(200);
      expect((await call(signedOutCookie)).status).toBe(401);
    } finally {
      await handles.stop();
      await db.prisma.$disconnect();
      await db.pool.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
