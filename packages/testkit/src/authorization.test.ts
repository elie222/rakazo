import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { appContract } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>;
type RpcPath<T, Prefix extends string = ""> = T extends { "~orpc": unknown }
  ? Prefix
  : T extends object
    ? {
        [Key in keyof T & string]: RpcPath<T[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
      }[keyof T & string]
    : never;
type ProtectedRpcPath = Exclude<RpcPath<typeof appContract>, "health">;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("API authorization and resource isolation", () => {
  let handles: AppHandles;
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-authz-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated calls to every protected RPC family", async () => {
    const calls = exhaustiveProtectedCalls([
      ["me"],
      ["deployment/get"],
      ["deployment/update", { signupsEnabled: true }],
      ["models/list"],
      ["models/credentials"],
      ["models/connect", { provider: "test", apiKey: "not-a-real-key" }],
      ["models/beginOAuth", { provider: "openai-codex" }],
      ["models/completeOAuth", { loginId: "missing-login" }],
      ["models/setDefault", { provider: "test", modelId: "test/model" }],
      ["bots/list"],
      ["bots/get", { botId: "missing-bot" }],
      ["bots/create", botInput("Unauthenticated")],
      ["bots/duplicate", { botId: "missing-bot" }],
      ["bots/update", { botId: "missing-bot", name: "Nope" }],
      ["bots/remove", { botId: "missing-bot" }],
      ["threads/get", { botId: "missing-bot" }],
      ["threads/messages", { botId: "missing-bot", before: 1 }],
      ["threads/subscribe", { botId: "missing-bot", cursor: -1 }],
      ["threads/send", { botId: "missing-bot", text: "Nope" }],
      ["threads/stop", { botId: "missing-bot" }],
      ["threads/followUp", { botId: "missing-bot", text: "Nope" }],
      ["threads/answer", { botId: "missing-bot", runId: "missing-run", answer: "Nope" }],
      ["threads/markRead", { botId: "missing-bot" }],
      ["threads/markUnread", { botId: "missing-bot" }],
      ["computer/status", { botId: "missing-bot" }],
      ["computer/boot", { botId: "missing-bot" }],
      ["computer/stop", { botId: "missing-bot" }],
      ["computer/takeover", { botId: "missing-bot" }],
      ["computer/release", { botId: "missing-bot" }],
      ["computer/input", { botId: "missing-bot", kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: "missing-bot", path: "/" }],
      ["computer/readFile", { botId: "missing-bot", path: "MEMORY.md" }],
      ["computer/screenUrl", { botId: "missing-bot" }],
      ["computer/heartbeat", { botId: "missing-bot" }],
      ["memory/list", {}],
      ["memory/update", { documentId: "missing-memory", content: "Nope" }],
      ["memory/exportMarkdown", {}],
      ["routines/list", { botId: "missing-bot" }],
      ["routines/create", routineInput("missing-bot")],
      ["routines/update", { routineId: "missing-routine", name: "Nope" }],
      ["routines/remove", { routineId: "missing-routine" }],
      ["routines/testRun", { routineId: "missing-routine" }],
      ["capabilities/list"],
      ["capabilities/install", capabilityInput("Unauthenticated")],
      ["capabilities/remove", { id: "missing-capability" }],
      ["connections/catalog", {}],
      ["connections/list"],
      ["connections/begin", connectionInput("Unauthenticated")],
      ["connections/complete", { connectionId: "missing-connection" }],
      ["connections/revoke", { connectionId: "missing-connection" }],
      ["artifacts/list", { botId: "missing-bot" }],
      ["usage/list"],
      ["usage/summary"],
      ["export/bot", { botId: "missing-bot" }],
      ["notifications/registerPush", { token: "ExponentPushToken[not-real]" }],
    ]);

    const results = await Promise.all(
      calls.map(async ([procedure, input]) => ({
        procedure,
        response: await raw(app, "", procedure, input),
      })),
    );

    for (const { procedure, response } of results) {
      expect(response.status, procedure).toBe(401);
    }
  });

  it("prevents one user from reading or mutating another user's resources", async () => {
    const owner = await signup(app, `owner-authz-${stamp}@rakazo.test`, "Authorization Owner");
    const intruder = await signup(
      app,
      `intruder-authz-${stamp}@rakazo.test`,
      "Authorization Intruder",
    );
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const intruderActor = await rpc<Actor>(app, intruder, "me");
    expect(ownerActor.workspaceId).not.toBe(intruderActor.workspaceId);

    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot"));
    const intruderBot = await rpc<Bot>(app, intruder, "bots/create", botInput("Intruder Bot"));
    const ownerRoutine = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownerBot.id),
    );
    const ownerCapability = await rpc<{ id: string }>(
      app,
      owner,
      "capabilities/install",
      capabilityInput("Owner Capability"),
    );
    const ownerConnection = await rpc<{ connectionId: string }>(
      app,
      owner,
      "connections/begin",
      connectionInput("Owner Connection"),
    );
    const ownerMemory = await handles.prisma.memoryDocument.create({
      data: {
        workspaceId: ownerActor.workspaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        scope: "bot",
        path: "PRIVATE.md",
        content: "owner-only-memory",
      },
    });
    await handles.prisma.artifact.create({
      data: {
        workspaceId: ownerActor.workspaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        name: "owner-secret.txt",
        mimeType: "text/plain",
        size: 17,
        hash: "sha256:not-a-real-hash",
        storageKey: "test/owner-secret.txt",
      },
    });
    const ownerThread = await handles.prisma.thread.findUniqueOrThrow({
      where: { botId: ownerBot.id },
    });
    const ownerTask = await handles.prisma.task.create({
      data: {
        workspaceId: ownerActor.workspaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        prompt: "owner prompt",
        status: "waiting_input",
      },
    });
    const ownerRun = await handles.prisma.run.create({
      data: {
        workspaceId: ownerActor.workspaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        taskId: ownerTask.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const botIdCalls: Array<[string, unknown]> = [
      ["bots/get", { botId: ownerBot.id }],
      ["bots/duplicate", { botId: ownerBot.id }],
      ["bots/update", { botId: ownerBot.id, name: "Stolen Bot" }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      ["threads/answer", { botId: ownerBot.id, runId: ownerRun.id, answer: "intruder answer" }],
      ["threads/markRead", { botId: ownerBot.id }],
      ["threads/markUnread", { botId: ownerBot.id }],
      ["computer/status", { botId: ownerBot.id }],
      ["computer/boot", { botId: ownerBot.id }],
      ["computer/stop", { botId: ownerBot.id }],
      ["computer/takeover", { botId: ownerBot.id }],
      ["computer/release", { botId: ownerBot.id }],
      ["computer/input", { botId: ownerBot.id, kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: ownerBot.id, path: "/" }],
      ["computer/readFile", { botId: ownerBot.id, path: "PRIVATE.md" }],
      ["computer/screenUrl", { botId: ownerBot.id }],
      ["computer/heartbeat", { botId: ownerBot.id }],
      ["routines/list", { botId: ownerBot.id }],
      ["routines/create", routineInput(ownerBot.id)],
      ["artifacts/list", { botId: ownerBot.id }],
      ["export/bot", { botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      ["memory/update", { documentId: ownerMemory.id, content: "stolen" }],
      ["connections/complete", { connectionId: ownerConnection.connectionId }],
    ] satisfies Array<[string, unknown]>;
    await Promise.all(
      resourceIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    expect(await rpc<unknown[]>(app, intruder, "memory/list", { botId: ownerBot.id })).toEqual([]);
    expect(await rpc<string>(app, intruder, "memory/exportMarkdown", { botId: ownerBot.id })).toBe(
      "",
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "capabilities/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerCapability.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );

    // These endpoints are deliberately idempotent for unknown IDs. Success must not mutate
    // a row in a different workspace or disclose whether it exists.
    await rpc(app, intruder, "capabilities/remove", { id: ownerCapability.id });
    await rpc(app, intruder, "connections/revoke", {
      connectionId: ownerConnection.connectionId,
    });
    expect(
      await handles.prisma.capabilityInstall.findUnique({ where: { id: ownerCapability.id } }),
    ).not.toBeNull();
    expect(
      await handles.prisma.connection.findUniqueOrThrow({
        where: { id: ownerConnection.connectionId },
      }),
    ).toMatchObject({ status: "pending", userId: ownerActor.userId });

    const ownerBotAfter = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await handles.prisma.routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await handles.prisma.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/remove", { botId: ownerBot.id });
    expect(await handles.prisma.bot.findUnique({ where: { id: ownerBot.id } })).not.toBeNull();
  });

  it("restricts deployment settings to the deployment owner", async () => {
    const owner = await signup(app, `deployment-owner-${stamp}@rakazo.test`, "Deployment Owner");
    const other = await signup(app, `deployment-other-${stamp}@rakazo.test`, "Deployment Other");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const otherActor = await rpc<Actor>(app, other, "me");
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: {
        ownerUserId: ownerActor.userId,
        signupsEnabled: true,
        signupAllowlist: "",
      },
    });

    expect(otherActor.userId).not.toBe(ownerActor.userId);

    await rpc(app, owner, "deployment/get");
    await expectDenied(app, other, "deployment/get", {});
    await expectDenied(app, other, "deployment/update", {
      signupsEnabled: false,
      signupAllowlist: ["attacker@example.test"],
    });
    expect(
      await handles.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }),
    ).toMatchObject({ signupsEnabled: true, signupAllowlist: "" });
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

function routineInput(botId: string) {
  return {
    botId,
    name: "Owner Routine",
    prompt: "owner-only prompt",
    cron: "0 9 * * 1",
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function capabilityInput(name: string) {
  return { kind: "skill", name, source: "test://authorization", config: {} };
}

function connectionInput(displayName: string) {
  return { provider: "test-provider", displayName };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function raw(app: App, cookie: string, procedure: string, body: unknown = {}) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await raw(app, cookie, procedure, body);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}

async function expectDenied(app: App, cookie: string, procedure: string, body: unknown) {
  const response = await raw(app, cookie, procedure, body);
  if (procedure === "threads/subscribe" && response.status === 200) {
    // Streaming transports commit the HTTP 200 before advancing the async iterator. The
    // ownership error is therefore encoded in the iterator response instead of the status.
    expect(await response.text(), procedure).toMatch(/error|forbidden|not.found|unauthorized/i);
    return;
  }
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}

interface Actor {
  userId: string;
  workspaceId: string;
}

interface Bot {
  id: string;
}

function exhaustiveProtectedCalls<
  const Calls extends ReadonlyArray<readonly [ProtectedRpcPath, unknown?]>,
>(calls: Calls & (ProtectedRpcPath extends Calls[number][0] ? unknown : never)): Calls {
  return calls;
}
