import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discardBotIntroRun } from "../../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../../packages/testkit/src/index.js";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "lets an API key use its person's bots through the OpenAI-compatible, task and MCP routes",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-bot-access-"));
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
      const signUp = async (name: string) => {
        const password = "test-password-123";
        const response = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: `${name}-${Date.now()}@example.test`, password, name }),
        });
        expect(response.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(response);
        const call = async (procedure: string, json: unknown = {}) => {
          const answer = await handles.app.request(`/rpc/${procedure}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie, origin },
            body: JSON.stringify({ json }),
          });
          return { status: answer.status, body: ((await answer.json()) as { json: never }).json };
        };
        const confirm = () =>
          handles.app.request("/api/auth/confirm-identity", {
            method: "POST",
            headers: { "content-type": "application/json", cookie, origin },
            body: JSON.stringify({ password }),
          });
        return { cookie, call, confirm };
      };
      const owner = await signUp("owner");
      const other = await signUp("other");
      const created = await owner.call("bots/create", {
        name: "Scout",
        title: "",
        description: "",
        instructions: "Answer briefly.",
        notifyOnFinish: false,
      });
      expect(created.status).toBe(200);
      const botId = (created.body as { id: string }).id;
      await discardBotIntroRun(handles, owner.cookie, botId);
      const otherBot = await other.call("bots/create", {
        name: "Hidden",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const otherBotId = (otherBot.body as { id: string }).id;
      await discardBotIntroRun(handles, other.cookie, otherBotId);

      // A key needs a fresh identity confirmation, and is shown once.
      expect((await owner.call("apiKeys/create", { name: "script" })).status).toBe(403);
      expect((await owner.confirm()).status).toBe(200);
      const key = await owner.call("apiKeys/create", { name: "script" });
      expect(key.status).toBe(200);
      const secret = (key.body as { key: string }).key;
      expect(secret).toMatch(/^rkz_/);
      const listed = await owner.call("apiKeys/list");
      expect(JSON.stringify(listed.body)).not.toContain(secret);

      const api = (path: string, init: RequestInit = {}, bearer = secret) =>
        handles.app.request(`/api/v1${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            ...init.headers,
          },
        });

      expect((await api("/models", {}, "rkz_not-a-key")).status).toBe(401);
      // A key never opens the app's own procedures.
      const rpcWithKey = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ json: {} }),
      });
      expect(rpcWithKey.status).toBe(401);

      const models = (await (await api("/models")).json()) as { data: Array<{ id: string }> };
      expect(models.data.map((model) => model.id)).toEqual([botId]);

      const refused = await api("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: otherBotId, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(refused.status).toBe(404);

      const completion = await api("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "Scout", messages: [{ role: "user", content: "Hello" }] }),
      });
      expect(completion.status).toBe(200);
      const answer = (await completion.json()) as {
        object: string;
        choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      };
      expect(answer.object).toBe("chat.completion");
      expect(answer.choices[0]).toMatchObject({
        message: { role: "assistant", content: expect.any(String) },
        finish_reason: "stop",
      });
      const taskId = completion.headers.get("x-rakazo-task-id")!;
      const task = (await (await api(`/tasks/${taskId}`)).json()) as { status: string };
      expect(task.status).toBe("completed");

      const streamed = await api("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: botId,
          stream: true,
          messages: [{ role: "user", content: "Again" }],
        }),
      });
      expect(streamed.headers.get("content-type")).toContain("text/event-stream");
      const events = (await streamed.text()).split("\n\n").filter(Boolean);
      expect(events.at(-1)).toBe("data: [DONE]");
      const chunks = events
        .slice(0, -1)
        .filter((event) => event.startsWith("data: "))
        .map((event) => JSON.parse(event.slice(6)) as { object: string; choices: unknown[] });
      expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
      expect(chunks.at(-1)?.choices[0]).toMatchObject({ finish_reason: "stop" });

      const mcp = await handles.app.request("/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_bots", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      expect(JSON.stringify(await mcp.json())).toContain(botId);

      const keyId = (key.body as { id: string }).id;
      expect((await owner.call("apiKeys/revoke", { id: keyId })).status).toBe(200);
      expect((await api("/models")).status).toBe(401);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
