import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import { runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

const stackToken = "cd".repeat(32);
const appCookie = `${LOCAL_SIGNUP_COOKIE}=${localSignupKey(stackToken)}`;

it.skipIf(!databaseUrl)(
  "the app-managed stack on this computer admits accounts only from the desktop app",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-desktop-accounts-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "docker",
      sandbox: new FakeSandboxProvider(),
      desktopStackToken: stackToken,
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
    });
    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      handles.app.request(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: webOrigin, ...headers },
        body: JSON.stringify(body),
      });
    const registrationOpen = async (headers: Record<string, string> = {}) => {
      const response = await handles.app.request("/api/auth/capabilities", { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      return (await response.json()).registrationOpen;
    };
    const account = (email: string) => ({ email, password: "test-password-123", name: "Local" });
    const suffix = Math.random().toString(36).slice(2);
    const owner = account(`owner-${suffix}@example.test`);
    const second = account(`second-${suffix}@example.test`);
    const stranger = account(`stranger-${suffix}@example.test`);
    try {
      expect(await registrationOpen()).toBe(false);
      expect(await registrationOpen({ cookie: appCookie })).toBe(true);

      // A browser or another local user reaches the loopback port, but never with the app's cookie.
      const refused = await post("/sign-up/email", stranger);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
      expect(
        (
          await post("/sign-up/email", stranger, {
            cookie: `${LOCAL_SIGNUP_COOKIE}=${"0".repeat(64)}`,
          })
        ).status,
      ).toBe(400);

      expect((await post("/sign-up/email", owner, { cookie: appCookie })).status).toBe(200);
      expect((await post("/sign-up/email", second, { cookie: appCookie })).status).toBe(200);
      const strangers = await runAsSystem("count refused accounts", () =>
        handles.prisma.user.count({ where: { email: stranger.email } }),
      );
      expect(strangers).toBe(0);

      // Existing accounts sign in from anywhere that reaches the server, such as the phone app.
      expect((await post("/sign-in/email", owner)).status).toBe(200);
      expect((await post("/sign-in/email", second)).status).toBe(200);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
