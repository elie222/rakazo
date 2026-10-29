import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discardBotIntroRun } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "applies the configured upload limit through the composed app",
  async () => {
    const maxUploadSizeBytes = 20 * 1024 * 1024;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-upload-limit-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      maxUploadSizeBytes,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `upload-limit-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Upload tester",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = (procedure: string, json: unknown = {}) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json }),
        });

      const me = await call("me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ json: { maxUploadSizeBytes } });

      const bot = await call("bots/create", {
        name: "Upload fixture",
        title: "",
        description: "",
        instructions: "Keep files.",
        notifyOnFinish: false,
      });
      expect(bot.status).toBe(200);
      const botId = ((await bot.json()) as { json: { id: string } }).json.id;
      await discardBotIntroRun(handles, cookie, botId);
      // Above the 10 MiB default, within the configured limit.
      const upload = await call("artifacts/create", {
        botId,
        name: "large.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.alloc(12 * 1024 * 1024, "a").toString("base64"),
      });
      expect(upload.status).toBe(200);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
