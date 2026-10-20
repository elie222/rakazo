import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComposioEmulator } from "@rakazo/adapters";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import { startModelEmulator } from "../model-emulator.js";

/** Isolated real executor + deterministic model protocol for the browser gallery. */
export async function crossChatGallery(origin: string) {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const dataDir = await mkdtemp(path.join(tmpdir(), "cross-chat-gallery-"));
  let stop: (() => Promise<void>) | undefined;
  let closeModel: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    try {
      await stop?.();
    } finally {
      try {
        await closeModel?.();
      } finally {
        await container.stop();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  };
  try {
    const databaseUrl = container.getConnectionUri();
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    let messageId = "";
    let threadId = "";
    const latest = (messages: Array<{ role: string; content?: unknown }>) =>
      JSON.parse(String(messages.findLast((message) => message.role === "tool")?.content));
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "find-earlier-chat",
            name: "search_history",
            arguments: { scope: "my_chats", queries: ["quasar launch", "violet apricot"] },
          },
        },
        {
          expect(request) {
            const result = latest(request.messages);
            const hit = result.messages.find(
              (hit: { messageId: string }) => hit.messageId === messageId,
            );
            if (
              !hit?.text.includes("VIOLET-APRICOT-731") ||
              hit.threadId !== threadId ||
              hit.matchedQueryIndexes.length !== 2
            )
              throw new Error(
                "Cross-chat search did not return the original fact and query attribution",
              );
          },
          response() {
            return {
              type: "tool",
              id: "open-earlier-chat",
              name: "read_history",
              arguments: { messageId, threadId, limit: 1 },
            };
          },
        },
        {
          expect(request) {
            if (!latest(request.messages).messages[0]?.text.includes("VIOLET-APRICOT-731"))
              throw new Error("Cross-chat read did not verify the original fact");
          },
          response: {
            type: "text",
            text: "Researcher recorded the Quasar launch code: VIOLET-APRICOT-731.",
          },
        },
      ],
    });
    closeModel = model.close;
    const { createApp } = await import("../../../../apps/api/src/app.js");
    const handles = await createApp({
      databaseUrl,
      realtimeDatabaseUrl: databaseUrl,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "synthetic-gallery-encryption-key",
      deploymentModelKey: undefined,
    });
    stop = handles.stop;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: "history-gallery@rakazo.test",
        password: "password12",
        name: "History Demo",
      }),
    });
    if (!signup.ok) throw new Error("Gallery signup failed");
    const cookie = sessionCookieHeader(signup);
    const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ json: input }),
      });
      const body = (await response.json()) as { json: T; error?: unknown };
      if (!response.ok || body.error) throw new Error(`Gallery ${procedure} failed`);
      return body.json;
    };
    const bot = async (name: string) => {
      const created = await rpc<{ id: string }>("bots/create", {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, created.id);
      return created;
    };
    const researcher = await bot("Researcher");
    const assistant = await bot("Assistant");
    const thread = await handles.prisma.thread.findFirstOrThrow({
      where: { botId: researcher.id },
    });
    threadId = thread.id;
    const source = await handles.prisma.message.create({
      data: {
        threadId,
        seq: 0,
        role: "user",
        createdAt: new Date("2026-01-15"),
        blocks: [{ kind: "text", text: "The Quasar launch code is VIOLET-APRICOT-731." }],
      },
    });
    messageId = source.id;
    await handles.prisma.thread.update({ where: { id: threadId }, data: { nextMessageSeq: 1 } });
    await rpc("models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      contextWindow: 160000,
      maxTokens: 4096,
    });
    await rpc("bots/update", {
      botId: assistant.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
    const run = await rpc<{ runId: string }>("threads/send", {
      botId: assistant.id,
      text: "Find the launch code from my earlier conversation with Researcher.",
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await handles.prisma.run.findUniqueOrThrow({ where: { id: run.runId } });
      if (state.status === "failed") {
        model.assertComplete();
        throw new Error("Gallery history run failed");
      }
      if (state.status === "completed") {
        model.assertComplete();
        return { app: handles.app, cookie, botId: assistant.id, cleanup };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Gallery history run timed out");
  } catch (error) {
    await cleanup();
    throw error;
  }
}
