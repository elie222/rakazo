import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const DAY_MS = 24 * 60 * 60 * 1000;

it.skipIf(!databaseUrl)(
  "sends the browser a renewed session cookie when an app request renews the session",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-session-renewal-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    try {
      const email = `session-renewal-${Date.now()}@example.test`;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "test-password-123", name: "Renewal tester" }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const me = (headers: Record<string, string>) =>
        handles.app.request("/rpc/me", {
          method: "POST",
          headers: { "content-type": "application/json", origin, ...headers },
          body: JSON.stringify({ json: {} }),
        });
      const sessionCookies = (response: Response) =>
        response.headers.getSetCookie().filter((value) => value.includes("session_token="));

      // A session used within the day is not renewed, so nothing is sent.
      const fresh = await me({ cookie });
      expect(fresh.status).toBe(200);
      expect(sessionCookies(fresh)).toEqual([]);

      // Three days on, the next request renews the session.
      const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
      const aged = new Date(Date.now() + 4 * DAY_MS);
      await handles.prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: aged },
      });
      const renewed = await me({ cookie });
      expect(renewed.status).toBe(200);
      const [sent] = sessionCookies(renewed);
      expect(sent).toContain(cookie.split("; ").find((part) => part.includes("session_token="))!);
      expect(Number(/max-age=(\d+)/i.exec(sent ?? "")?.[1])).toBeGreaterThan(6 * 24 * 60 * 60);
      const stored = await handles.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
      expect(stored.expiresAt.getTime()).toBeGreaterThan(aged.getTime() + DAY_MS);

      // A native client holds a bearer token, not a cookie.
      await handles.prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: aged },
      });
      const token = decodeURIComponent(
        cookie
          .split("; ")
          .find((part) => part.includes("session_token="))!
          .split("=")[1]!,
      );
      const native = await me({ authorization: `Bearer ${token}` });
      expect(native.status).toBe(200);
      expect(sessionCookies(native)).toEqual([]);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
