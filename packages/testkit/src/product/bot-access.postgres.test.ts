import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const password = "test-password-123";

describe.skipIf(!databaseUrl)("bot access with an API key, through the composed app", () => {
  let dataDir: string;
  let handles: AppHandles;
  let owner: Awaited<ReturnType<typeof signUp>>;
  let botId: string;
  let otherBotId: string;
  let key: { id: string; key: string };

  async function signUp(name: string) {
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
    const createBot = async (botName: string) => {
      const created = await call("bots/create", {
        name: botName,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const id = (created.body as { id: string }).id;
      await discardBotIntroRun(handles, cookie, id);
      return id;
    };
    const confirm = () =>
      handles.app.request("/api/auth/confirm-identity", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ password }),
      });
    return { call, createBot, confirm };
  }

  const api = (route: string, init: RequestInit = {}, bearer = key.key) =>
    handles.app.request(`/api/v1${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  const chat = (model: string, content: string, stream = false) =>
    api("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content }] }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-bot-access-"));
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    owner = await signUp("owner");
    botId = await owner.createBot("Scout");
    otherBotId = await (await signUp("other")).createBot("Hidden");
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("makes a key only after the person confirms it's them, and never lists it again", async () => {
    expect((await owner.call("apiKeys/create", { name: "script" })).status).toBe(403);
    expect((await owner.confirm()).status).toBe(200);
    const created = await owner.call("apiKeys/create", { name: "script" });
    expect(created.status).toBe(200);
    key = created.body as { id: string; key: string };
    expect(key.key).toMatch(/^rkz_/);
    expect(JSON.stringify((await owner.call("apiKeys/list")).body)).not.toContain(key.key);
  });

  it("never opens the app's own procedures with a key", async () => {
    const response = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("lists only the person's bots, and answers another person's bot as not found", async () => {
    const models = (await (await api("/models")).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((model) => model.id)).toEqual([botId]);
    expect((await chat(otherBotId, "hi")).status).toBe(404);
  });

  it("runs a real turn for a chat completion, readable as a task", async () => {
    const completion = await chat("Scout", "Hello");
    expect(completion.status).toBe(200);
    expect(await completion.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant" }, finish_reason: "stop" }],
    });
    const taskId = completion.headers.get("x-rakazo-task-id")!;
    expect(await (await api(`/tasks/${taskId}`)).json()).toMatchObject({ status: "completed" });
  });

  it("streams a turn as chunks ending in [DONE]", async () => {
    const streamed = await chat(botId, "Again", true);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const events = (await streamed.text()).split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.slice("data: ".length)) as { choices: unknown[] });
    expect(chunks.at(-1)?.choices[0]).toMatchObject({ finish_reason: "stop" });
  });

  it("serves the MCP tools with the key", async () => {
    const response = await handles.app.request("/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.key}`,
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
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(botId);
  });

  it("refuses a revoked key", async () => {
    expect((await owner.call("apiKeys/revoke", { id: key.id })).status).toBe(200);
    expect((await api("/models")).status).toBe(401);
  });
});
