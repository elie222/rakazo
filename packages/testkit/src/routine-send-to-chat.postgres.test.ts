import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Routine } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeRoutines = hasDb ? describe : describe.skip;

describeRoutines("routines that send their replies to chat", () => {
  let app: App;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-routine-send-to-chat-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("keeps replies in the app until asked, and saves the switch on create and update", async () => {
    const cookie = await signup(app, `routine-chat-${stamp}@rakazo.test`, "Chat User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Brief",
      title: "Brief",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const create = (name: string, extra: Record<string, unknown> = {}) =>
      rpc<Routine>(app, cookie, "routines/create", {
        botId: bot.id,
        name,
        prompt: "Send the morning brief",
        crons: ["0 8 * * *"],
        timezone: "UTC",
        active: false,
        ...extra,
      });

    const plain = await create("Plain");
    const chatty = await create("Chatty", { sendToChat: true });
    expect(plain.sendToChat).toBe(false);
    expect(chatty.sendToChat).toBe(true);

    // An edit that does not mention the switch leaves it as it was.
    await rpc(app, cookie, "routines/update", { routineId: chatty.id, name: "Chatty renamed" });
    const listed = async () =>
      Object.fromEntries(
        (await rpc<Routine[]>(app, cookie, "routines/list", { botId: bot.id })).map((routine) => [
          routine.id,
          routine.sendToChat,
        ]),
      );
    expect(await listed()).toEqual({ [plain.id]: false, [chatty.id]: true });

    await rpc(app, cookie, "routines/update", { routineId: chatty.id, sendToChat: false });
    await rpc(app, cookie, "routines/update", { routineId: plain.id, sendToChat: true });
    expect(await listed()).toEqual({ [plain.id]: true, [chatty.id]: false });
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
