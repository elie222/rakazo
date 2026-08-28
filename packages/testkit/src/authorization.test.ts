import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
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
      composio: new ComposioEmulator(),
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
      ["updater/status"],
      ["updater/check", {}],
      ["updater/apply", {}],
      ["models/list"],
      ["models/credentials"],
      ["models/connect", { provider: "test", apiKey: "not-a-real-key" }],
      ["models/beginOAuth", { provider: "openai-codex" }],
      ["models/submitOAuthCode", { loginId: "missing-login", code: "fake-code" }],
      ["models/completeOAuth", { loginId: "missing-login" }],
      ["models/finishOAuth", { loginId: "missing-login" }],
      ["models/cancelOAuth", { loginId: "missing-login" }],
      ["models/setDefault", { provider: "test", modelId: "test/model" }],
      ["bots/list"],
      ["bots/listArchived"],
      ["bots/get", { botId: "missing-bot" }],
      ["bots/create", botInput("Unauthenticated")],
      ["bots/duplicate", { botId: "missing-bot" }],
      ["bots/update", { botId: "missing-bot", name: "Nope" }],
      ["bots/archive", { botId: "missing-bot" }],
      ["bots/restore", { botId: "missing-bot" }],
      ["bots/remove", { botId: "missing-bot" }],
      ["groups/create", { name: "Nope", botIds: ["missing-a", "missing-b"] }],
      ["groups/list"],
      ["groups/get", { groupId: "missing-group" }],
      ["groups/update", { groupId: "missing-group", name: "Nope" }],
      ["groups/remove", { groupId: "missing-group" }],
      ["botSections/list"],
      ["botSections/create", { botId: "missing-bot", name: "Planning" }],
      ["threads/get", { botId: "missing-bot" }],
      ["threads/get", { groupId: "missing-group" }],
      ["threads/messages", { botId: "missing-bot", before: 1 }],
      ["threads/subscribe", { botId: "missing-bot", cursor: -1 }],
      ["threads/send", { botId: "missing-bot", text: "Nope" }],
      ["threads/send", { groupId: "missing-group", text: "Nope" }],
      ["threads/stop", { botId: "missing-bot" }],
      ["threads/clear", { botId: "missing-bot" }],
      ["threads/followUp", { botId: "missing-bot", text: "Nope" }],
      [
        "threads/answer",
        {
          botId: "missing-bot",
          runId: "missing-run",
          messageId: "missing-message",
          answer: "Nope",
        },
      ],
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
      ["scratchpad/list", { botId: "missing-bot" }],
      ["scratchpad/create", { botId: "missing-bot", title: "Nope" }],
      ["scratchpad/update", { itemId: "missing-item", title: "Nope" }],
      ["scratchpad/remove", { itemId: "missing-item" }],
      ["skills/list", { botId: "missing-bot" }],
      ["skills/get", { skillId: "missing-skill" }],
      ["skills/start", { botId: "missing-bot", goal: "Demonstrate export" }],
      [
        "skills/appendEvent",
        {
          skillId: "missing-skill",
          event: { at: new Date().toISOString(), kind: "key", key: "a" },
        },
      ],
      ["skills/snapshot", { skillId: "missing-skill" }],
      ["skills/stop", { skillId: "missing-skill" }],
      ["skills/updateDraft", { skillId: "missing-skill", playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: "missing-skill" }],
      ["skills/testRun", { skillId: "missing-skill" }],
      ["skills/remove", { skillId: "missing-skill" }],
      ["agentSkills/list"],
      ["agentSkills/get", { skillId: "missing-skill" }],
      ["agentSkills/create", { name: "Unauthenticated", description: "Nope", body: "Steps" }],
      ["agentSkills/update", { skillId: "missing-skill", description: "Nope" }],
      ["agentSkills/remove", { skillId: "missing-skill" }],
      ["capabilities/list"],
      ["capabilities/install", capabilityInput("Unauthenticated")],
      ["capabilities/remove", { id: "missing-capability" }],
      ["connections/catalog", {}],
      ["connections/list"],
      ["connections/begin", connectionInput("Unauthenticated")],
      ["connections/complete", { connectionId: "missing-connection" }],
      ["connections/revoke", { connectionId: "missing-connection" }],
      ["approvalRules/list"],
      [
        "approvalRules/set",
        { effect: "require_approval", matchKind: "category", matchValue: "email" },
      ],
      ["approvalRules/remove", { id: "missing-rule" }],
      ["artifacts/list", { botId: "missing-bot" }],
      ["usage/list"],
      ["usage/summary"],
      ["export/bot", { botId: "missing-bot" }],
      ["notifications/registerPush", { token: "ExponentPushToken[not-real]" }],
      ["search/query", { q: "anything" }],
      ["voice/catalog"],
      ["voice/status"],
      ["voice/credentials"],
      ["voice/connect", { provider: "elevenlabs", apiKey: "not-a-real-key" }],
      ["voice/setVoice", { voiceId: "missing-voice" }],
      ["voice/voices", {}],
      ["voice/prepare", { text: "Nope" }],
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
    const ownerScratchpad = await rpc<{ id: string }>(app, owner, "scratchpad/create", {
      botId: ownerBot.id,
      title: "Owner open work",
      notes: "private",
    });
    const ownerSkill = await handles.prisma.taughtSkill.create({
      data: {
        workspaceId: ownerActor.workspaceId,
        botId: ownerBot.id,
        userId: ownerActor.userId,
        name: "Owner Skill",
        goal: "Owner-only skill",
        status: "saved",
        playbook: skillPlaybookInput(),
        recording: { events: [], snapshots: [] },
      },
    });
    const ownerAgentSkill = await rpc<{ id: string }>(app, owner, "agentSkills/create", {
      name: "Owner Recipe",
      description: "Owner-only shared skill",
      body: "1. Do the private thing.",
    });
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
    const ownerArtifact = await handles.prisma.artifact.create({
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
      ["bots/archive", { botId: ownerBot.id }],
      ["bots/restore", { botId: ownerBot.id }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/send", { botId: ownerBot.id, artifactIds: [ownerArtifact.id] }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/clear", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      [
        "threads/answer",
        {
          botId: ownerBot.id,
          runId: ownerRun.id,
          messageId: "missing-message",
          answer: "intruder answer",
        },
      ],
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
      ["scratchpad/list", { botId: ownerBot.id }],
      ["scratchpad/create", { botId: ownerBot.id, title: "Stolen item" }],
      ["skills/list", { botId: ownerBot.id }],
      ["skills/start", { botId: ownerBot.id, goal: "Intruder demo" }],
      ["artifacts/list", { botId: ownerBot.id }],
      [
        "artifacts/create",
        {
          botId: ownerBot.id,
          name: "intruder.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("nope").toString("base64"),
        },
      ],
      ["artifacts/get", { botId: ownerBot.id, artifactId: ownerArtifact.id }],
      ["export/bot", { botId: ownerBot.id }],
      ["voice/prepare", { text: "stolen speech", botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    const ownerBot2 = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot Two"));
    const ownerGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Owner Group",
      botIds: [ownerBot.id, ownerBot2.id],
    });
    const groupCalls: Array<[string, unknown]> = [
      ["groups/get", { groupId: ownerGroup.id }],
      ["groups/update", { groupId: ownerGroup.id, name: "Stolen Group" }],
      ["groups/remove", { groupId: ownerGroup.id }],
      ["threads/get", { groupId: ownerGroup.id }],
      ["threads/messages", { groupId: ownerGroup.id, before: 1 }],
      ["threads/subscribe", { groupId: ownerGroup.id, cursor: -1 }],
      ["threads/send", { groupId: ownerGroup.id, text: "intruder group message" }],
      ["threads/stop", { groupId: ownerGroup.id }],
      ["threads/followUp", { groupId: ownerGroup.id, text: "intruder follow-up" }],
      ["threads/markRead", { groupId: ownerGroup.id }],
      ["threads/markUnread", { groupId: ownerGroup.id }],
    ];
    await Promise.all(
      groupCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      messageId: "missing-message",
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      ["scratchpad/update", { itemId: ownerScratchpad.id, title: "Stolen item" }],
      ["scratchpad/remove", { itemId: ownerScratchpad.id }],
      ["skills/get", { skillId: ownerSkill.id }],
      [
        "skills/appendEvent",
        { skillId: ownerSkill.id, event: { at: new Date().toISOString(), kind: "key", key: "x" } },
      ],
      ["skills/snapshot", { skillId: ownerSkill.id }],
      ["skills/stop", { skillId: ownerSkill.id }],
      ["skills/updateDraft", { skillId: ownerSkill.id, playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: ownerSkill.id }],
      ["skills/testRun", { skillId: ownerSkill.id }],
      ["skills/remove", { skillId: ownerSkill.id }],
      ["agentSkills/get", { skillId: ownerAgentSkill.id }],
      ["agentSkills/update", { skillId: ownerAgentSkill.id, description: "Stolen" }],
      ["agentSkills/remove", { skillId: ownerAgentSkill.id }],
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
    expect(await rpc<Array<{ id: string }>>(app, intruder, "agentSkills/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerAgentSkill.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );
    expect(
      await rpc<{ hits: unknown[] }>(app, intruder, "search/query", { q: ownerBot.name }),
    ).toEqual({ hits: [] });

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
    ).toMatchObject({ status: "connected", userId: ownerActor.userId });

    const ownerBotAfter = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await handles.prisma.routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await handles.prisma.scratchpadItem.findUniqueOrThrow({ where: { id: ownerScratchpad.id } }),
    ).toMatchObject({ title: "Owner open work", notes: "private" });
    expect(
      await handles.prisma.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/remove", {
      botId: ownerBot.id,
      deleteMemories: true,
    });
    expect(await handles.prisma.bot.findUnique({ where: { id: ownerBot.id } })).not.toBeNull();
  });

  it("keeps approval rules private to each user in a shared workspace", async () => {
    const owner = await signup(app, `approval-owner-${stamp}@rakazo.test`, "Approval Owner");
    const member = await signup(app, `approval-member-${stamp}@rakazo.test`, "Approval Member");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const memberActor = await rpc<Actor>(app, member, "me");

    await handles.prisma.member.deleteMany({ where: { userId: memberActor.userId } });
    await handles.prisma.member.create({
      data: {
        id: `approval-member-${stamp}`,
        organizationId: ownerActor.workspaceId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });

    const ownerRule = await rpc<{ id: string }>(app, owner, "approvalRules/set", {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    expect(await rpc<unknown[]>(app, member, "approvalRules/list")).toEqual([]);

    const memberRule = await rpc<{ id: string }>(app, member, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    });
    expect(await rpc<Array<{ id: string }>>(app, owner, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: ownerRule.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, member, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: memberRule.id }),
    ]);

    await rpc(app, member, "approvalRules/remove", { id: ownerRule.id });
    expect(
      await handles.prisma.actionApprovalRule.findUnique({ where: { id: ownerRule.id } }),
    ).not.toBeNull();
  });

  it("isolates model defaults by workspace and switches them atomically", async () => {
    const cookie = await signup(app, `model-defaults-${stamp}@rakazo.test`, "Model Defaults");
    const actor = await rpc<Actor>(app, cookie, "me");
    const otherWorkspaceId = `other-model-workspace-${stamp}`;
    const otherSecret = await handles.prisma.secret.create({
      data: {
        userId: actor.userId,
        workspaceId: otherWorkspaceId,
        kind: "model",
        ciphertext: "encrypted-other-workspace-key",
      },
    });
    const otherCredential = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        workspaceId: otherWorkspaceId,
        provider: "other-provider",
        label: "Other workspace",
        secretId: otherSecret.id,
        isDefault: true,
        defaultModel: "other/model",
      },
    });

    const beforeConnect = await rpc<Me>(app, cookie, "me");
    expect(beforeConnect.workspaceId).toBe(actor.workspaceId);
    expect(beforeConnect.defaultProvider).not.toBe("other-provider");
    expect(beforeConnect.defaultModel).not.toBe("other/model");
    const expectWorkspaceModelDefault = async (provider: string, defaultModel: string) => {
      const rows = await handles.prisma.userModelCredential.findMany({
        where: { userId: actor.userId, workspaceId: actor.workspaceId },
      });
      expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
      expect(rows.find((row) => row.provider === provider)).toMatchObject({
        isDefault: true,
        defaultModel,
      });
      expect(rows.filter((row) => row.isDefault)[0]?.provider).toBe(provider);
    };

    const connectedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-key",
      label: "Provider A",
      modelId: "a/one",
    });
    expect(connectedA.isDefault).toBe(true);
    const providerABeforeRotation = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });

    const rotatedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-replacement-key",
      label: "Provider A rotated",
      modelId: "a/rotated",
    });
    const providerAAfterRotation = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });
    expect(rotatedA.id).toBe(connectedA.id);
    expect(providerAAfterRotation.secretId).not.toBe(providerABeforeRotation.secretId);
    expect(
      await handles.prisma.secret.findUnique({ where: { id: providerABeforeRotation.secretId } }),
    ).toBeNull();
    expect(
      await handles.prisma.userModelCredential.count({
        where: {
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          provider: "provider-a",
        },
      }),
    ).toBe(1);

    const connectedB = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-b",
      apiKey: "fake-provider-b-key",
      label: "Provider B",
      modelId: "b/one",
    });
    expect(connectedB.isDefault).toBe(true);
    expect(
      await handles.prisma.userModelCredential.count({
        where: { userId: actor.userId, workspaceId: actor.workspaceId, isDefault: true },
      }),
    ).toBe(1);

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/two" });
    await expectWorkspaceModelDefault("provider-a", "a/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-b", modelId: "b/two" });
    await expectWorkspaceModelDefault("provider-b", "b/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/three" });
    await expectWorkspaceModelDefault("provider-a", "a/three");

    const otherAfter = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: otherCredential.id },
    });
    expect(otherAfter).toMatchObject({ isDefault: true, defaultModel: "other/model" });
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-a-key");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-b-key");

    const missing = await raw(app, cookie, "models/setDefault", {
      provider: "missing-provider",
      modelId: "missing/model",
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toMatch(/credential/i);
  });

  it("validates per-bot model overrides against connected providers and catalog", async () => {
    const cookie = await signup(app, `bot-model-${stamp}@rakazo.test`, "Bot Model");
    const bot = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/create", botInput("Model Bot"));
    await rpc(app, cookie, "models/connect", {
      provider: "xai",
      apiKey: "fake-xai-key-not-real",
      label: "xAI",
      modelId: "grok-4.6",
    });

    const updated = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });

    const unknown = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "not-a-real-grok",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await unknown.text()).toMatch(/unknown model/i);

    const disconnected = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).toMatch(/connect/i);

    const partialClear = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelId: null,
    });
    expect(partialClear.status).toBeGreaterThanOrEqual(400);
    expect(await partialClear.text()).toMatch(/both be set or both cleared/i);
  });

  it("chooses the newest duplicate provider credential when selecting a default", async () => {
    const cookie = await signup(app, `model-duplicates-${stamp}@rakazo.test`, "Model Duplicates");
    const actor = await rpc<Actor>(app, cookie, "me");
    const olderSecret = await handles.prisma.secret.create({
      data: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        kind: "model",
        ciphertext: "encrypted-older-key",
      },
    });
    const newerSecret = await handles.prisma.secret.create({
      data: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        kind: "model",
        ciphertext: "encrypted-newer-key",
      },
    });
    const older = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        provider: "duplicate-provider",
        label: "Older",
        secretId: olderSecret.id,
        isDefault: true,
        defaultModel: "older/model",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const newer = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        provider: "duplicate-provider",
        label: "Newer",
        secretId: newerSecret.id,
        defaultModel: "newer/model",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });

    await rpc(app, cookie, "models/setDefault", {
      provider: "duplicate-provider",
      modelId: "newer/selected",
    });

    const rows = await handles.prisma.userModelCredential.findMany({
      where: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        provider: "duplicate-provider",
      },
    });
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([newer.id]);
    expect(rows.find((row) => row.id === newer.id)).toMatchObject({
      isDefault: true,
      defaultModel: "newer/selected",
    });
    expect(rows.find((row) => row.id === older.id)).toMatchObject({
      isDefault: false,
      defaultModel: "older/model",
    });
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(
      listed.filter((row) => row.provider === "duplicate-provider").map((row) => row.id),
    ).toEqual([newer.id, older.id]);
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
    await expectForbidden(app, other, "updater/status", {});
    await expectForbidden(app, other, "updater/check", {});
    await expectForbidden(app, other, "updater/apply", {});
    expect(
      await handles.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }),
    ).toMatchObject({ signupsEnabled: true, signupAllowlist: "" });

    try {
      await rpc(app, owner, "deployment/update", { signupsEnabled: false });
      const closedSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `closed-${stamp}@rakazo.test`,
          password: "password123",
          name: "Closed Signup",
        }),
      });
      expect(closedSignup.status).toBe(400);
      expect(await closedSignup.text()).toContain("Registration is closed");

      const approvedEmail = `approved-${stamp}@example.test`;
      await rpc(app, owner, "deployment/update", {
        signupsEnabled: true,
        signupAllowlist: [approvedEmail],
      });
      const disallowedSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `not-approved-${stamp}@rakazo.test`,
          password: "password123",
          name: "Disallowed Signup",
        }),
      });
      expect(disallowedSignup.status).toBe(400);
      expect(await disallowedSignup.text()).toContain("Email is not allowed to register");
      await signup(app, approvedEmail, "Approved Signup");
    } finally {
      await rpc(app, owner, "deployment/update", {
        signupsEnabled: true,
        signupAllowlist: [],
      });
    }
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
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function skillPlaybookInput() {
  return {
    whenToUse: "When needed",
    inputs: ["example"],
    steps: ["Do the thing"],
    howToCheck: "Verify result",
    whatToReturn: "Summary",
    approvalBoundaries: "Ask first",
    failureHandling: "Stop and ask",
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

async function expectForbidden(app: App, cookie: string, procedure: string, body: unknown) {
  const response = await raw(app, cookie, procedure, body);
  expect(response.status, procedure).toBe(403);
  expect(await response.text(), procedure).toMatch(/forbidden/i);
}

interface Actor {
  userId: string;
  workspaceId: string;
}

interface Me extends Actor {
  defaultProvider: string | null;
  defaultModel: string | null;
}

interface ModelCredential {
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
}

interface Bot {
  id: string;
}

function exhaustiveProtectedCalls<
  const Calls extends ReadonlyArray<readonly [ProtectedRpcPath, unknown?]>,
>(calls: Calls & (ProtectedRpcPath extends Calls[number][0] ? unknown : never)): Calls {
  return calls;
}
