import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient, PiAgentRuntime } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../index.js";
import { startModelEmulator } from "../model-emulator.js";
import { asSystem } from "../system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const fixtureKey = "offline-deployment-model-fixture";
const connection = { provider: "deepseek", modelId: "deepseek-flash", method: "api_key" } as const;
const reply = "The shared deployment model answered this team member.";

type App = Awaited<ReturnType<typeof createApp>>["app"];

describe.skipIf(!enabled)("shared deployment model journey", () => {
  it("lets a verified admin connect a model, serves a teammate, and stops serving on disconnect", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", connection.provider);
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    vi.stubEnv("PI_DEFAULT_CREDENTIALS", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("MODEL_CREDIT_OFFERINGS", undefined);
    const tag = `${process.pid}-${Date.now()}`;
    const adminEmail = `deployment-admin-${tag}@rakazo.test`;
    const memberEmail = `deployment-member-${tag}@rakazo.test`;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-deployment-model-"));
    let model: Awaited<ReturnType<typeof startModelEmulator>> | undefined;
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const emulator = await startModelEmulator({
        apiKey: fixtureKey,
        modelId: connection.modelId,
        steps: [
          {
            expect: (request) => expect(request.tools).toEqual(expect.any(Array)),
            response: { type: "text", text: "Connection verified." },
          },
          {
            expect: (request) => expect(request.messages.at(-1)).toMatchObject({ role: "user" }),
            response: { type: "text", text: `${reply} ${fixtureKey}` },
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ],
      });
      model = emulator;
      const modelFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (
          url.origin !== "https://api.deepseek.com" ||
          !["/chat/completions", "/v1/chat/completions"].includes(url.pathname)
        )
          throw new Error("Unexpected model endpoint in the offline deployment fixture.");
        return fetch(`${emulator.baseUrl}/chat/completions`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        });
      };
      const { createApp } = await import("@rakazo/api/app");
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        encryptionKey: "offline-deployment-model-encryption-key",
        adminEmails: [adminEmail],
        sandboxProvider: "fake",
        agentRuntime: "pi",
        runtime: new PiAgentRuntime({ modelFetch }),
        modelConnectionFetch: modelFetch,
        contextStrategy: "current",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        billingEmulator: false,
        stripeSecretKey: undefined,
        composio: new ComposioConnector({ client: new FakeComposioClient() }),
      });
      const { app } = handles;
      const db = asSystem(handles.prisma);
      const admin = await signup(app, adminEmail, "Deployment admin");
      const member = await signup(app, memberEmail, "Team member");
      const adminMe = await rpc(app, admin, "me");
      const memberMe = await rpc(app, member, "me");
      expect(adminMe).toMatchObject({ isAdmin: false, needsModel: true });
      expect(memberMe).toMatchObject({ isAdmin: false, needsModel: true });

      await db.user.update({ where: { id: adminMe.userId }, data: { emailVerified: true } });
      expect(await rpc(app, admin, "me")).toMatchObject({ isAdmin: true });

      const organization = await rpc(app, admin, "organizations/create", { name: "Fixture Team" });
      const invitation = await rpc(app, admin, "organizations/invitations/create", {
        organizationId: organization.id,
        email: memberEmail,
      });
      await rpc(app, member, "organizations/invitations/accept", {
        invitationId: new URL(invitation.url).pathname.split("/").at(-1)!,
      });
      const spaceId = organization.defaultSpaceId;
      await rpc(app, admin, "spaces/members/add", { spaceId, userId: memberMe.userId }, spaceId);
      expect(await rpc(app, member, "me", undefined, spaceId)).toMatchObject({ spaceId });
      // Create with no configured model so an automatic intro cannot consume the fixture reply.
      const bot = await rpc(
        app,
        admin,
        "bots/create",
        {
          name: "Shared model fixture",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        },
        spaceId,
      );
      const send = { botId: bot.id, text: "Run the shared model fixture." };

      const adminConnection = { ...connection, apiKey: fixtureKey };
      expect(
        (await request(app, member, "models/setSharedDeployment", adminConnection, spaceId)).status,
      ).toBe(403);
      const hostBefore = await db.deploymentSettings.update({
        where: { id: "default" },
        data: { computerHost: "this-mac" },
        select: { computerHost: true, updatedAt: true },
      });
      await rpc(app, admin, "models/setSharedDeployment", adminConnection, spaceId);

      const stored = await db.deploymentModelConnection.findUniqueOrThrow({
        where: { id: "default" },
      });
      expect(stored).toMatchObject({ ...connection, credentialCipher: expect.any(String) });
      expect(stored.credentialCipher).not.toContain(fixtureKey);
      expect(
        await runAsTenant({ spaceId, userId: memberMe.userId }, () =>
          handles!.prisma.deploymentModelConnection.findUnique({ where: { id: "default" } }),
        ),
      ).toBeNull();
      expect(await rpc(app, admin, "models/sharedDeployment", undefined, spaceId)).toMatchObject({
        connection,
      });
      expect(
        (await request(app, member, "models/sharedDeployment", undefined, spaceId)).status,
      ).toBe(403);
      expect(await rpc(app, member, "models/credentials", undefined, spaceId)).toEqual([]);
      expect(await rpc(app, member, "me", undefined, spaceId)).toMatchObject({
        isAdmin: false,
        needsModel: false,
        defaultProvider: connection.provider,
        defaultModel: connection.modelId,
      });

      const { runId } = await rpc(app, member, "threads/send", send, spaceId);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
            status: "completed",
            userId: memberMe.userId,
          });
        },
        { timeout: 15_000 },
      );
      const snapshot = await rpc(app, member, "threads/get", { botId: bot.id }, spaceId);
      expect(JSON.stringify(snapshot)).toContain(reply);
      expect(JSON.stringify(snapshot)).not.toContain(fixtureKey);
      expect(await db.usageRecord.findFirst({ where: { runId } })).toMatchObject({
        userId: memberMe.userId,
        provider: connection.provider,
        model: connection.modelId,
        fundingSource: "operator",
      });

      await rpc(app, admin, "models/setSharedDeployment", null, spaceId);
      expect(await rpc(app, admin, "models/sharedDeployment", undefined, spaceId)).toMatchObject({
        connection: null,
      });
      expect(
        (await db.deploymentModelConnection.findUnique({ where: { id: "default" } }))
          ?.credentialCipher ?? null,
      ).toBeNull();
      expect(
        await db.deploymentSettings.findUniqueOrThrow({
          where: { id: "default" },
          select: { computerHost: true, updatedAt: true },
        }),
      ).toEqual(hostBefore);
      expect(await rpc(app, member, "me", undefined, spaceId)).toMatchObject({ needsModel: true });
      const afterDisconnect = await request(app, member, "threads/send", send, spaceId);
      expect(afterDisconnect.status).toBe(400);
      expect(await afterDisconnect.text()).toContain(MODEL_REQUIRED_SEND_ERROR);
      emulator.assertComplete();
    } finally {
      await handles?.stop();
      await model?.close();
      await rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 45_000);
});

async function signup(app: App, email: string, name: string): Promise<string> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, name, password: "password12" }),
  });
  if (!response.ok)
    throw new Error(`Sign-up failed (${response.status}): ${await response.text()}`);
  return sessionCookieHeader(response);
}

function request(app: App, cookie: string, procedure: RpcPath, input: unknown, spaceId?: string) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: input === undefined ? {} : input }),
  });
}

async function rpc<Procedure extends RpcPath>(
  app: App,
  cookie: string,
  procedure: Procedure,
  input?: RpcInput<NoInfer<Procedure>>,
  spaceId?: string,
): Promise<RpcOutput<Procedure>> {
  const response = await request(app, cookie, procedure, input, spaceId);
  if (!response.ok) throw new Error(`${procedure} (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { json: RpcOutput<Procedure> }).json;
}
