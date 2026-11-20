import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  connectorToolRequiresApproval,
  inferAttachmentMimeType,
  messageBlockForArtifact,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { capabilities, creativeFixture, musicInput } from "./creative.test-support.js";
import {
  creativeCapabilitiesSchema,
  creativeInputSchema,
  creativeJobSchema,
} from "./creative-contracts.js";
import {
  CreativeServiceError,
  creativeConnectionSchema,
  UserCreativeProvider,
} from "./creative-provider.js";
import { ConnectorRegistry } from "./integrations/connector-registry.js";
import { clipToolResultContent, TOOL_RESULT_TEXT_LIMIT } from "./runtime/pi/pi-runtime-limits.js";
import { serializeToolResult } from "./runtime/pi/tools/pi-runtime-tools.js";
import type { attachWorkspaceFileToThread } from "./storage/thread-artifacts.js";

vi.mock("./storage/thread-artifacts.js", () => ({
  attachWorkspaceFileToThread: async (
    ...[deps, input]: Parameters<typeof attachWorkspaceFileToThread>
  ) => {
    await deps.artifacts.put(
      {
        name: input.filePath,
        mimeType: inferAttachmentMimeType(input.filePath)!,
        bytes: input.bytes,
      },
      {} as AdapterContext,
    );
    const artifact = await deps.prisma.artifact.create({
      data: {
        userId: input.userId,
        spaceId: input.spaceId,
        botId: input.botId,
        runId: input.runId,
        name: input.name ?? input.filePath,
        mimeType: inferAttachmentMimeType(input.filePath)!,
        size: input.bytes.byteLength,
        hash: "test-hash",
        storageKey: "test-storage",
      },
    });
    await input.onAttached?.(deps.prisma, artifact);
    return { artifactId: artifact.id, block: messageBlockForArtifact(artifact) };
  },
}));
vi.mock("./runs/assembly/run-messages.js", () => ({
  persistMessageInTransaction: async (
    tx: PrismaClient,
    run: { threadId: string },
    role: string,
    blocks: unknown[],
    _unread: boolean,
    clientNonce: string,
  ) => {
    const message = await tx.message.create({
      data: {
        threadId: run.threadId,
        role,
        blocks: blocks as never,
        clientNonce,
        seq: 1,
        searchTokens: [],
      },
    });
    return { message, eventSeq: 1, firstResponseRunId: undefined };
  },
}));

async function tool(
  f: ReturnType<typeof creativeFixture>,
  name: string,
  args: Record<string, unknown>,
  executionId = "execution-a",
) {
  const context = f.context();
  const registry = new ConnectorRegistry([f.connector]);
  const selected = (await registry.discoverTools(context)).find(
    (tool) => tool.route?.toolName === name,
  )!;
  expect(selected).toBeDefined();
  const events = [];
  for await (const event of registry.execute(
    { tool: selected.name, route: selected.route, args, executionId },
    context,
  ))
    events.push(event);
  return events;
}
function output(f: ReturnType<typeof creativeFixture>, mimeType = "audio/mpeg", id = "output-a") {
  const operationId = String(f.effects[0]!.id);
  f.remote.get(`account-a:${operationId}`)!.job = {
    operationId,
    status: "succeeded",
    outputs: [{ id, mimeType, name: "Offline example" }],
  };
  return operationId;
}
async function credential(f: ReturnType<typeof creativeFixture>, userId = "user-a") {
  return { ...f.identities.get(userId)! };
}

describe("creative app v1 offline contract", () => {
  it("uses the revised music example and accepts partial unknown outputs", () => {
    const music = capabilities.models.find((model) => model.kind === "music")!;
    expect(
      creativeCapabilitiesSchema.parse({ models: [music], defaults: { music: music.id } }),
    ).toMatchObject({
      models: [{ presets: [{ id: "demo-song" }, { id: "demo-inst" }], defaultPreset: "demo-inst" }],
    });
    expect(
      creativeInputSchema.safeParse({ ...musicInput, parameters: { mode: "song" } }).success,
    ).toBe(true);
    expect(
      creativeJobSchema.parse({
        operationId: randomUUID(),
        status: "unknown",
        outputs: [{ id: "partial", name: "Example", mimeType: "audio/mpeg" }],
      }).outputs,
    ).toHaveLength(1);
    expect(
      creativeCapabilitiesSchema.safeParse({
        models: [{ ...music, defaultPreset: "missing" }],
        defaults: {},
      }).success,
    ).toBe(false);
  });
  it("reads a selected model's complete schema, constraints, presets and submission limits", async () => {
    const f = creativeFixture();
    await f.connect();
    const video = capabilities.models.find((model) => model.kind === "video")!;
    expect(await tool(f, "creative_capabilities", { model: video.id })).toEqual([
      {
        type: "result",
        data: {
          availableKinds: { image: 1, video: 1, music: 1 },
          defaults: {},
          submission: capabilities.submission,
          models: [video],
        },
      },
    ]);
    expect(f.putCount()).toBe(0);
  });
  it.each(["image", "video", "music"] as const)(
    "lists lightweight %s models with complete counts",
    async (kind) => {
      const f = creativeFixture();
      await f.connect();
      const { id, name } = capabilities.models.find((model) => model.kind === kind)!;
      expect(await tool(f, "creative_capabilities", { kind })).toEqual([
        {
          type: "result",
          data: {
            availableKinds: { image: 1, video: 1, music: 1 },
            defaults: kind === "music" ? capabilities.defaults : {},
            total: 1,
            offset: 0,
            nextOffset: null,
            models: [{ id, name, kind }],
          },
        },
      ]);
      expect(f.putCount()).toBe(0);
    },
  );
  it.each(["current", "retrieval"] as const)(
    "discovers a late image model and reads its full rules within the %s tool budget",
    async (strategy) => {
      const f = creativeFixture();
      const image = capabilities.models.find((model) => model.kind === "image")!;
      const video = capabilities.models.find((model) => model.kind === "video")!;
      const music = capabilities.models.find((model) => model.kind === "music")!;
      const catalog = {
        ...capabilities,
        models: [
          music,
          ...Array.from({ length: 10 }, (_, index) => ({
            ...video,
            id: `fixture-video-${index}`,
            parameters: {
              type: "object",
              properties: Object.fromEntries(
                Array.from({ length: 18 }, (_, field) => [
                  `option_${field}`,
                  { type: "string", enum: ["default", "alternate"] },
                ]),
              ),
            },
          })),
          image,
        ],
        defaults: { image: image.id, music: music.id },
      };
      expect(JSON.stringify(catalog).length).toBeGreaterThan(TOOL_RESULT_TEXT_LIMIT);
      f.setCatalog(catalog);
      await f.connect();
      const read = async (args: Record<string, unknown>) => {
        const events = await tool(f, "creative_capabilities", args);
        expect(events[0]?.type).toBe("result");
        const data = (events[0] as { data: unknown }).data;
        const visible = clipToolResultContent([
          {
            type: "text",
            text: serializeToolResult(data, strategy, "creative_capabilities", args),
          },
        ])[0]!.text;
        expect(JSON.parse(visible)).toEqual(data);
        return JSON.parse(visible);
      };
      const all = await read({});
      expect(all.availableKinds).toEqual({ image: 1, video: 10, music: 1 });
      expect(all.total).toBe(12);
      expect(all.nextOffset).toBeNull();
      expect(all.models.at(-1)).toEqual({ id: image.id, name: image.name, kind: "image" });
      expect(await read({ kind: "image" })).toEqual({
        availableKinds: all.availableKinds,
        defaults: { image: image.id },
        total: 1,
        offset: 0,
        nextOffset: null,
        models: [{ id: image.id, name: image.name, kind: "image" }],
      });
      expect(await read({ model: all.defaults.image })).toEqual({
        availableKinds: all.availableKinds,
        defaults: { image: image.id },
        submission: capabilities.submission,
        models: [image],
      });
      expect(f.putCount()).toBe(0);
      expect(
        await tool(f, "creative_submit", {
          kind: "image",
          model: all.defaults.image,
          prompt: "Synthetic autumn scene",
        }),
      ).toMatchObject([{ type: "result", data: { status: "queued" } }]);
      expect(f.putCount()).toBe(1);
      expect(f.effects[0]!.request).toMatchObject({
        input: { kind: "image", model: image.id, preset: image.defaultPreset },
      });
    },
  );
  it.each(["current", "retrieval"] as const)(
    "pages a maximum-sized lightweight directory without losing models in %s context",
    async (strategy) => {
      const f = creativeFixture();
      const image = capabilities.models.find((model) => model.kind === "image")!;
      const models = Array.from({ length: 200 }, (_, index) => ({
        ...image,
        id: `image-${index}-${"i".repeat(180)}`,
        name: `图片 ${index} ${"界".repeat(180)}`,
      }));
      const defaults = { image: models.at(-1)!.id };
      f.setCatalog({ ...capabilities, models, defaults });
      await f.connect();
      let offset: number | null = 0;
      const received: unknown[] = [];
      while (offset !== null) {
        const args = { kind: "image", offset };
        const events = await tool(f, "creative_capabilities", args);
        expect(events[0]?.type).toBe("result");
        const data = (events[0] as { data: unknown }).data;
        const visible = clipToolResultContent([
          {
            type: "text",
            text: serializeToolResult(data, strategy, "creative_capabilities", args),
          },
        ])[0]!.text;
        expect(visible.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
        const page = JSON.parse(visible);
        expect(page).toEqual(data);
        expect(page).toMatchObject({
          availableKinds: { image: 200, video: 0, music: 0 },
          defaults,
          total: 200,
          offset,
        });
        expect(page.models.length).toBeGreaterThan(0);
        if (offset === 0) {
          expect(page.models).not.toContainEqual({
            id: models.at(-1)!.id,
            name: models.at(-1)!.name,
            kind: "image",
          });
          expect(
            await tool(f, "creative_capabilities", { model: page.defaults.image }),
          ).toMatchObject([
            {
              type: "result",
              data: { models: [models.at(-1)], submission: capabilities.submission },
            },
          ]);
        }
        received.push(...page.models);
        if (page.nextOffset !== null) {
          expect(page.nextOffset).toBe(offset + page.models.length);
          expect(page.nextOffset).toBeLessThan(models.length);
        }
        offset = page.nextOffset;
      }
      expect(received).toEqual(models.map(({ id, name, kind }) => ({ id, name, kind })));
      expect(f.putCount()).toBe(0);
    },
  );
  it("reports a genuine empty image catalog without substituting another media kind", async () => {
    const f = creativeFixture();
    const music = capabilities.models.find((model) => model.kind === "music")!;
    f.setCatalog({ ...capabilities, models: [music], defaults: { music: music.id } });
    await f.connect();
    expect(await tool(f, "creative_capabilities", { kind: "image" })).toEqual([
      {
        type: "result",
        data: {
          availableKinds: { image: 0, video: 0, music: 1 },
          defaults: {},
          total: 0,
          offset: 0,
          nextOffset: null,
          models: [],
        },
      },
    ]);
    expect(f.putCount()).toBe(0);
  });
  it("refuses to return an incomplete oversized model schema", async () => {
    const f = creativeFixture();
    const image = capabilities.models.find((model) => model.kind === "image")!;
    f.setCatalog({
      ...capabilities,
      models: [{ ...image, parameters: { description: "x".repeat(TOOL_RESULT_TEXT_LIMIT) } }],
      defaults: { image: image.id },
    });
    await f.connect();
    expect(await tool(f, "creative_capabilities", { model: image.id })).toEqual([
      { type: "error", message: "Creative app: capabilities_too_large" },
    ]);
    expect(await tool(f, "creative_capabilities", { kind: "image" })).toMatchObject([
      { type: "result", data: { availableKinds: { image: 1 }, total: 1 } },
    ]);
    expect(f.putCount()).toBe(0);
  });
  it.each([
    [{ kind: "audio" }, "invalid_parameters"],
    [{ model: "" }, "invalid_parameters"],
    [{ unexpected: true }, "invalid_parameters"],
    [{ offset: -1 }, "invalid_parameters"],
    [{ offset: 0.5 }, "invalid_parameters"],
    [{ offset: 4 }, "invalid_parameters"],
    [{ model: "demo-image", offset: 0 }, "invalid_parameters"],
    [{ model: "missing" }, "selection_unavailable"],
    [{ kind: "image", model: "demo-video" }, "selection_unavailable"],
  ])("rejects an invalid model query %j", async (query, code) => {
    const f = creativeFixture();
    await f.connect();
    expect(await tool(f, "creative_capabilities", query as Record<string, unknown>)).toEqual([
      { type: "error", message: `Creative app: ${code}` },
    ]);
    expect(f.putCount()).toBe(0);
  });
  it("rejects insecure configuration and obsolete service-signing settings", () => {
    const f = creativeFixture();
    for (const config of [
      { ...f.config, origin: "http://creative.example.test" },
      { ...f.config, authorizationUrl: "http://creative.example.test" },
      { ...f.config, privateKey: "invalid" },
      { ...f.config, spaceIds: [] },
    ])
      expect(creativeConnectionSchema.safeParse(config).success).toBe(false);
  });
  it("automatically connects configured apps in existing and new spaces by default", async () => {
    const f = creativeFixture();
    f.config.spaceIds = undefined;
    const connector = f.rebuild();
    f.members.add("space-new:user-a");
    for (const spaceId of ["space-a", "space-new"]) {
      const context = { ...f.context(), spaceId };
      expect(await connector.catalog(context)).toMatchObject([{ connected: true }]);
    }
    expect(f.connections).toHaveLength(2);
    expect(f.history).toHaveLength(2);
    expect(f.connections[0]!.providerRef).not.toBe(f.connections[1]!.providerRef);
  });
  it("keeps an explicit space allowlist effective for discovery and connections", async () => {
    const f = creativeFixture();
    f.members.add("space-new:user-a");
    const context = { ...f.context(), spaceId: "space-new" };
    expect(await f.connector.catalog(context)).toEqual([]);
    expect(await f.connector.discoverTools(context)).toEqual([]);
    await expect(
      f.connector.begin(
        {
          provider: "creative",

          redirectUrl: "https://app.example.test",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.connections).toHaveLength(0);
    expect(f.history).toHaveLength(0);
  });
  it("automatically connects using only the person's original access token", async () => {
    const f = creativeFixture();
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: true }]);
    expect(f.history).toHaveLength(1);
    expect(f.history[0]).toMatchObject({
      method: "GET",
      user: "account-a",
      authorization: "Bearer fake-access-a",
    });
    expect(JSON.stringify(f.connections)).not.toContain("fake-access-a");
  });
  it("isolates A/B in one space and requires each person's own connection", async () => {
    const f = creativeFixture();
    await f.connect();
    expect(await f.connector.catalog(f.context("user-b"))).toMatchObject([{ connected: true }]);
    expect(
      await f.connector.discoverTools({
        ...f.context("user-b"),
        connectedConnections: f.context().connectedConnections,
      }),
    ).toEqual([]);
    expect(f.connections[1]!.providerRef).not.toBe(f.connections[0]!.providerRef);
    const credentialA = await credential(f),
      credentialB = await credential(f, "user-b");
    const operationId = randomUUID();
    await f.provider.submit(credentialA, operationId, musicInput, f.context().signal);
    await expect(
      f.provider.job(credentialB, operationId, f.context().signal),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(
      f.provider.output(credentialB, operationId, "output-a", f.context().signal),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    f.connections[0]!.status = "revoked";
    expect(await f.connector.listConnectedExternalIds(f.context("user-b"))).toEqual(["creative"]);
    expect(await f.connector.discoverTools(f.context())).toEqual([]);
    await f.provider.submit(credentialB, operationId, musicInput, f.context().signal);
    expect(f.remote.size).toBe(2);
  });
  it("reuses automatic connections and preserves a user's explicit disconnect", async () => {
    const f = creativeFixture();
    await f.connector.ensureConnection(f.context());
    const ref = f.connections[0]!.providerRef;
    await f.connector.ensureConnection(f.context());
    expect(f.connections).toHaveLength(1);
    expect(f.history).toHaveLength(1);
    f.connections[0]!.status = "revoked";
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: false }]);
    expect(f.connections).toHaveLength(1);
    expect(f.connections[0]!.providerRef).toBe(ref);
    expect(f.connections[0]!.status).toBe("revoked");
    expect(f.history).toHaveLength(1);
    await f.connect();
    expect(f.connections[1]!.providerRef).toBe(ref);
    expect(await f.connector.listConnectedExternalIds(f.context())).toEqual(["creative"]);
  });
  it("keeps automatic connections pending until upstream qualification is available", async () => {
    const f = creativeFixture();
    f.setLocalEligibility(false);
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: false }]);
    const ref = f.connections[0]!.providerRef;
    expect(f.connections[0]!.status).toBe("pending");
    expect(await f.connector.discoverTools(f.context())).toEqual([]);
    f.setLocalEligibility(true);
    f.setAuthenticationAvailable(false);
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: false }]);
    f.setAuthenticationAvailable(true);
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: true }]);
    expect(f.connections).toHaveLength(1);
    expect(f.connections[0]!.providerRef).toBe(ref);
    expect(f.putCount()).toBe(0);
  });
  it("does not overwrite a disconnect that happens during the automatic qualification check", async () => {
    const f = creativeFixture();
    const check = f.provider.capabilities.bind(f.provider);
    vi.spyOn(f.provider, "capabilities").mockImplementation(async (...args) => {
      const result = await check(...args);
      f.connections[0]!.status = "revoked";
      return result;
    });
    await f.connector.ensureConnection(f.context());
    expect(f.connections[0]!.status).toBe("revoked");
    expect(await f.connector.listConnectedExternalIds(f.context())).toEqual([]);
    expect(f.history).toHaveLength(1);
  });
  it("does not provision for an unverified identity or reuse a changed identity binding", async () => {
    const f = creativeFixture();
    f.identities.delete("user-a");
    await expect(f.connector.ensureConnection(f.context())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(f.connections).toHaveLength(0);
    await f.connector.ensureConnection(f.context("user-b"));
    f.identities.get("user-b")!.binding = "replacement-binding";
    expect(await f.connector.catalog(f.context("user-b"))).toMatchObject([{ connected: false }]);
    expect(f.connections).toHaveLength(1);
    expect(f.history).toHaveLength(1);
  });
  it("refreshes an expired access token without changing the operation or charging again", async () => {
    const f = creativeFixture();
    await f.connect();
    const before = await credential(f),
      id = randomUUID();
    await f.provider.submit(before, id, musicInput, f.context().signal);
    f.tokens.delete(await before.accessToken());
    f.tokens.set("fake-refreshed-access", "account-a");
    const refreshAccessToken = vi.fn(async () => "fake-refreshed-access");
    expect(
      await f.provider.job({ ...before, refreshAccessToken }, id, f.context().signal),
    ).toMatchObject({ operationId: id });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(f.putCount()).toBe(1);
    expect(f.remote.size).toBe(1);
  });
  it("blocks identity changes, disabled spaces and removed membership without assuming the bot owner", async () => {
    const f = creativeFixture();
    await f.connect();
    f.identities.set("user-a", {
      ...f.identities.get("user-a")!,
      binding: "different",
    });
    expect(await f.connector.discoverTools(f.context())).toEqual([]);
    expect(await f.connector.listConnectedExternalIds(f.context())).toEqual([]);
    expect(await f.connector.catalog({ ...f.context(), spaceId: "space-b" })).toEqual([]);
    f.members.clear();
    await expect(f.connector.listConnectedExternalIds(f.context())).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("keeps read-only directory checks separate from actual billing eligibility", async () => {
    const f = creativeFixture();
    await f.connect();
    const access = await credential(f);
    // The adapter consumes the snapshot; it never fetches a key or infers charging permission.
    await f.provider.capabilities(access, f.context().signal);
    expect(f.history.every((request) => !request.path.includes("keys"))).toBe(true);
    f.setBillingAuthorized(false);
    expect(await f.provider.capabilities(access, f.context().signal)).toMatchObject({
      models: capabilities.models,
    });
    await expect(
      f.provider.submit(access, randomUUID(), musicInput, f.context().signal),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.remote.size).toBe(0);
  });
  it("keeps pending consent read-only and rechecks the official authorization flow", async () => {
    const f = creativeFixture();
    f.setLocalEligibility(false);
    await f.connect();
    const row = f.connections[0]!;
    expect(row.status).toBe("pending");
    expect(await f.connector.discoverTools(f.context())).toEqual([]);
    expect(await f.connector.connectionReady(f.context(), "creative")).toBe(false);
    f.setLocalEligibility(true);
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: true }]);
    expect(await f.connector.connectionReady(f.context(), "creative")).toBe(true);
  });
  it("retains pending consent on a 503 without reopening authorization", async () => {
    const f = creativeFixture();
    f.setAuthenticationAvailable(false);
    await f.connect();
    expect(f.connections[0]!.status).toBe("pending");
    f.setAuthenticationAvailable(true);
    expect(await f.connector.connectionReady(f.context(), "creative")).toBe(true);
  });
  it("uses complete presets verbatim, refreshes changed catalogs, and never overrides parameters", async () => {
    const f = creativeFixture();
    await f.connect();
    const access = await credential(f),
      id = randomUUID();
    await f.provider.submit(access, id, musicInput, f.context().signal);
    f.setCatalog({
      models: [
        {
          ...capabilities.models[2]!,
          presets: [{ id: "new-inst", parameters: { mode: "instrumental", quality: "new" } }],
          defaultPreset: "new-inst",
        },
      ],
      defaults: { music: "demo-music" },
    });
    expect(
      (await f.provider.capabilities(access, f.context().signal)).models[0]!.defaultPreset,
    ).toBe("new-inst");
    expect(
      await f.provider.submit(
        access,
        id,
        {
          prompt: musicInput.prompt,
          preset: musicInput.preset,
          model: musicInput.model,
          kind: musicInput.kind,
        },
        f.context().signal,
      ),
    ).toMatchObject({ operationId: id });
    await expect(
      f.provider.submit(access, id, { ...musicInput, preset: "new-inst" }, f.context().signal),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(
      f.provider.submit(access, randomUUID(), musicInput, f.context().signal),
    ).rejects.toMatchObject({ code: "selection_unavailable" });
    expect(
      await f.provider.submit(
        access,
        randomUUID(),
        { ...musicInput, preset: "new-inst" },
        f.context().signal,
      ),
    ).toMatchObject({ status: "queued" });
  });
  it.each(["music", "video"] as const)(
    "pins an omitted %s default and replays the original tool input after restart",
    async (kind) => {
      const f = creativeFixture();
      await f.connect();
      const model = capabilities.models.find((model) => model.kind === kind)!;
      const input = { kind, model: model.id, prompt: "Offline default preset example" };
      const directory = vi.spyOn(f.provider, "capabilities");
      let restored: ReturnType<typeof f.rebuild> | undefined;
      try {
        expect(await tool(f, "creative_submit", input)).toMatchObject([
          { type: "result", data: { status: "queued" } },
        ]);
        const saved = f.effects[0]!;
        expect(saved.request).toMatchObject({
          input: { ...input, preset: model.defaultPreset },
          toolInput: input,
        });
        expect((saved.request as { toolInput: object }).toolInput).not.toHaveProperty("preset");
        const snapshot = structuredClone((saved.result as { submission: object }).submission);
        expect(snapshot).toMatchObject({ preset: model.defaultPreset });
        await f.connector.creativeJobs.stop();
        f.setCatalog({
          ...capabilities,
          models: capabilities.models.map((model) =>
            model.kind === kind
              ? {
                  ...model,
                  presets: [{ id: "changed-default", parameters: {} }],
                  defaultPreset: "changed-default",
                }
              : model,
          ),
        });
        restored = f.rebuild();
        expect(
          await tool({ ...f, connector: restored }, "creative_submit", {
            ...input,
            preset: undefined,
          }),
        ).toMatchObject([{ type: "result", data: { operationId: saved.id, status: "queued" } }]);
        expect(directory).toHaveBeenCalledOnce();
        expect(f.putCount()).toBe(1);
        expect(f.effects).toHaveLength(1);
        expect((f.effects[0]!.result as { submission: object }).submission).toEqual(snapshot);
        expect(
          await tool({ ...f, connector: restored }, "creative_submit", {
            ...input,
            prompt: "A different intent",
          }),
        ).toMatchObject([{ type: "error", message: "Creative app: operation_conflict" }]);
      } finally {
        await f.connector.creativeJobs.stop();
        await restored?.creativeJobs.stop();
      }
    },
  );
  it.each([
    [{ model: "Demo Music" }, "selection_unavailable"],
    [{ preset: "" }, "invalid_parameters"],
    [{ preset: "missing-preset" }, "selection_unavailable"],
  ])(
    "rejects an invalid explicit selection without substituting the default: %j",
    async (override, code) => {
      const f = creativeFixture();
      await f.connect();
      try {
        expect(await tool(f, "creative_submit", { ...musicInput, ...override })).toMatchObject([
          { type: "error", message: `Creative app: ${code}` },
        ]);
        expect(f.effects).toHaveLength(0);
        expect(f.putCount()).toBe(0);
      } finally {
        await f.connector.creativeJobs.stop();
      }
    },
  );
  it("validates and preserves an explicit preset even when another preset is the default", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setCatalog({
      ...capabilities,
      models: capabilities.models.map((model) =>
        model.kind === "music" ? { ...model, defaultPreset: "demo-song" } : model,
      ),
    });
    const directory = vi.spyOn(f.provider, "capabilities");
    try {
      expect(await tool(f, "creative_submit", musicInput)).toMatchObject([
        { type: "result", data: { status: "queued" } },
      ]);
      expect(directory).toHaveBeenCalledOnce();
      expect(f.effects[0]!.request).toMatchObject({ input: musicInput });
      expect(f.history.find((item) => item.method === "PUT")!.input).toEqual(musicInput);
    } finally {
      await f.connector.creativeJobs.stop();
    }
  });
  it("persists requested parameters, preserves false and zero, and compares retries independently of key order", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setCatalog({ ...capabilities, submission: { presetOnly: false, referenceMedia: false } });
    const input = {
      kind: "video",
      model: "demo-video",
      preset: "demo-video-default",
      prompt: "晨雾中的山谷",
      parameters: { resolution: "1080P", ratio: "16:9", seconds: 10, watermark: false, seed: 0 },
    };
    expect(await tool(f, "creative_submit", input)).toMatchObject([
      { type: "result", data: { status: "queued" } },
    ]);
    const effect = f.effects[0]!;
    expect(effect.request).toMatchObject({ input });
    expect(f.history.find((request) => request.method === "PUT")!.input).toEqual(input);
    const replay = {
      ...input,
      parameters: { seed: 0, watermark: false, seconds: 10, ratio: "16:9", resolution: "1080P" },
    };
    expect(await tool(f, "creative_submit", replay)).toMatchObject([
      { type: "result", data: { operationId: effect.id } },
    ]);
    expect(
      await tool(f, "creative_submit", {
        ...input,
        parameters: { ...input.parameters, seconds: 12 },
      }),
    ).toMatchObject([{ type: "error", message: "Creative app: operation_conflict" }]);
    expect(f.effects).toHaveLength(1);
    expect(f.putCount()).toBe(1);
  });
  it("recovers a parameterized submission from the saved operation without consulting a changed catalog", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setCatalog({ ...capabilities, submission: { presetOnly: false, referenceMedia: false } });
    const input = {
      kind: "video",
      model: "demo-video",
      preset: "demo-video-default",
      prompt: "晨雾中的山谷",
      parameters: { resolution: "1080P", seconds: 10 },
    };
    f.losePut();
    await tool(f, "creative_submit", input);
    const effect = f.effects[0]!;
    f.setCatalog({
      models: [],
      defaults: {},
      submission: { presetOnly: false, referenceMedia: false },
    });
    const restored = f.rebuild();
    await restored.creativeJobs.poll(String(effect.id));
    expect(f.history.filter((request) => request.method === "PUT")).toMatchObject([{ input }]);
    expect(f.remote.size).toBe(1);
    expect(f.putCount()).toBe(1);
    await restored.creativeJobs.stop();
    await f.connector.creativeJobs.stop();
  });
  it("rejects overrides when not advertised and rejects unknown parameter names before a paid request", async () => {
    const f = creativeFixture();
    await f.connect();
    const input = {
      kind: "video",
      model: "demo-video",
      preset: "demo-video-default",
      prompt: "晨雾中的山谷",
      parameters: { resolution: "1080P" },
    };
    expect(await tool(f, "creative_submit", input)).toMatchObject([
      { type: "error", message: "Creative app: invalid_parameters" },
    ]);
    f.setCatalog({ ...capabilities, submission: { presetOnly: false, referenceMedia: false } });
    expect(
      await tool(f, "creative_submit", { ...input, parameters: { apiKey: "fake-rejected-value" } }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(f.effects).toHaveLength(0);
    expect(f.putCount()).toBe(0);
  });
  it("preserves an upstream parameter rejection without falling back to a different preset", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setCatalog({ ...capabilities, submission: { presetOnly: false, referenceMedia: false } });
    expect(
      await tool(f, "creative_submit", {
        kind: "video",
        model: "demo-video",
        preset: "demo-video-default",
        prompt: "晨雾中的山谷",
        parameters: { seconds: 99 },
      }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(f.putCount()).toBe(1);
    expect(f.remote.size).toBe(0);
    expect(f.effects).toHaveLength(1);
  });
  it("requires the existing approval gate for paid tools", async () => {
    const f = creativeFixture();
    await f.connect();
    const tools = await new ConnectorRegistry([f.connector]).discoverTools(f.context());
    const paid = tools.find((tool) => tool.route?.toolName === "creative_submit")!;
    expect(connectorToolRequiresApproval(paid.route!.toolName, paid.readOnly)).toBe(true);
    expect(paid.inputSchema.properties).toHaveProperty("parameters");
    expect(paid.inputSchema.required).not.toContain("preset");
    // A refused approval never invokes the connector, so it has no intent or remote submit.
    expect(f.effects).toHaveLength(0);
    expect(f.putCount()).toBe(0);
  });
  it.each([
    ["image", "image/png"],
    ["video", "video/mp4"],
    ["music", "audio/mpeg"],
  ] as const)("delivers a synthetic %s output to the original chat", async (kind, mimeType) => {
    const f = creativeFixture();
    await f.connect();
    const model = capabilities.models.find((model) => model.kind === kind)!;
    const result = await tool(f, "creative_submit", {
      kind,
      model: model.id,
      preset: model.defaultPreset,
      prompt: "Offline example",
    });
    expect(result).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    const operationId = output(f, mimeType);
    await f.rebuild().creativeJobs.poll(operationId);
    expect(f.effects[0]!.status).toBe("creative_succeeded");
    expect(f.artifacts).toMatchObject([{ mimeType, userId: "user-a" }]);
    expect(f.messages).toMatchObject([{ threadId: "thread-a" }]);
    expect(f.remote.size).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fake-access-a");
    expect(JSON.stringify(f.effects)).not.toContain("fake-access-a");
    expect(JSON.stringify(f.messages)).not.toContain("Bearer");
  });
  it("reuses the winning operation when a concurrent upsert hits the unique constraint", async () => {
    const f = creativeFixture();
    await f.connect();
    const upsert = f.db.externalEffect.upsert.getMockImplementation()!;
    f.db.externalEffect.upsert.mockImplementationOnce(async (input) => {
      await upsert(input);
      throw new Prisma.PrismaClientKnownRequestError("Synthetic concurrent insert", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    expect(await tool(f, "creative_submit", musicInput)).toMatchObject([
      { type: "result", data: { status: "queued", operationId: f.effects[0]?.id } },
    ]);
    expect(f.effects).toHaveLength(1);
    expect(f.remote.size).toBe(1);
    expect(f.putCount()).toBe(1);
  });
  it("checks the original operation after a lost PUT response and does not submit twice", async () => {
    const f = creativeFixture();
    await f.connect();
    f.losePut();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    await Promise.all([f.rebuild().creativeJobs.poll(id), f.rebuild().creativeJobs.poll(id)]);
    expect(f.putCount()).toBe(1);
    expect(f.remote.size).toBe(1);
    expect(f.messages).toHaveLength(1);
  });
  it("reuses the persisted operation ID after a confirmed pre-accept timeout", async () => {
    const f = creativeFixture();
    await f.connect();
    f.loseBeforePut();
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    expect(f.remote.size).toBe(0);
    await f.rebuild().creativeJobs.poll(id);
    expect(f.remote.size).toBe(1);
    expect(
      new Set(f.history.filter((call) => call.method === "PUT").map((call) => call.path)).size,
    ).toBe(1);
  });
  it("does not allocate a paid operation when the initial directory cannot authenticate", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setAuthenticationAvailable(false);
    expect(await tool(f, "creative_submit", musicInput)).toMatchObject([
      { type: "error", message: "Creative app: authentication_unavailable" },
    ]);
    expect(f.effects).toHaveLength(0);
    expect(f.putCount()).toBe(0);
  });
  it("retains queued state across authentication 503 and resumes the same user and operation", async () => {
    const f = creativeFixture();
    await f.connect();
    f.setAuthenticationAvailable(false);
    expect(await f.connector.catalog(f.context())).toMatchObject([{ connected: true }]);
    f.setAuthenticationAvailable(true);
    const submit = f.provider.submit.bind(f.provider);
    vi.spyOn(f.provider, "submit").mockImplementationOnce((...args) => {
      f.setAuthenticationAvailable(false);
      return submit(...args);
    });
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id),
      ref = f.connections[0]!.providerRef;
    expect(f.effects[0]!.status).toBe("creative_pending");
    expect(f.remote.size).toBe(0);
    expect(f.effects[0]!.result).toMatchObject({ errorCode: "authentication_unavailable" });
    f.setAuthenticationAvailable(true);
    await Promise.all([f.rebuild().creativeJobs.poll(id), f.rebuild().creativeJobs.poll(id)]);
    expect(f.remote.size).toBe(1);
    expect(f.effects[0]!.request).toMatchObject({ ref });
    expect(f.remote.get(`account-a:${id}`)!.user).toBe("account-a");
  });
  it("does not send a queued request after revocation or identity switch", async () => {
    const f = creativeFixture();
    await f.connect();
    const submit = f.provider.submit.bind(f.provider);
    vi.spyOn(f.provider, "submit").mockImplementationOnce((...args) => {
      f.setAuthenticationAvailable(false);
      return submit(...args);
    });
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    f.connections[0]!.status = "revoked";
    f.setAuthenticationAvailable(true);
    await expect(f.rebuild().creativeJobs.poll(id)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.remote.size).toBe(0);
    expect(f.effects[0]!.status).toBe("creative_failed");
  });
  it("does not read another account binding through the selected account's result tool", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    await expect(
      f.connector.creativeJobs.result(f.context(), id, "different-account-binding"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("does not reuse a new connection for an old locally persisted intent", async () => {
    const f = creativeFixture();
    await f.connect();
    f.loseBeforePut();
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    f.identities.get("user-a")!.binding = "replacement-binding";
    await f.connect();
    await expect(f.rebuild().creativeJobs.poll(id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.connector.creativeJobs.result(f.context(), id, String(f.connections[0]!.providerRef)),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.remote.size).toBe(0);
  });
  it("delivers multiple music files once during concurrent recovery", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    f.remote
      .get(`account-a:${id}`)!
      .job.outputs.push({ id: "output-b", mimeType: "audio/mpeg", name: "Second offline example" });
    await Promise.all([f.rebuild().creativeJobs.poll(id), f.rebuild().creativeJobs.poll(id)]);
    await f.rebuild().creativeJobs.poll(id);
    expect(f.artifacts).toHaveLength(2);
    expect(f.messages).toHaveLength(2);
    expect(f.putCount()).toBe(1);
  });
  it("recovers an attachment saved before message publication without creating a second file", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    f.db.message.create.mockRejectedValueOnce(new Error("Synthetic publication outage"));
    await f.connector.creativeJobs.poll(id);
    expect(f.artifacts).toHaveLength(1);
    expect(f.messages).toHaveLength(0);
    await f.rebuild().creativeJobs.poll(id);
    expect(f.artifacts).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
    expect(f.putCount()).toBe(1);
  });
  it.each([503, 404])(
    "publishes a saved attachment without another download when outputs return %s",
    async (status) => {
      const f = creativeFixture();
      await f.connect();
      await tool(f, "creative_submit", musicInput);
      const id = output(f);
      f.db.message.create.mockRejectedValueOnce(new Error("Synthetic publication outage"));
      await f.connector.creativeJobs.poll(id);
      expect(f.artifacts).toHaveLength(1);
      expect(f.messages).toHaveLength(0);
      const download = vi
        .spyOn(f.provider, "output")
        .mockRejectedValue(
          new CreativeServiceError(status === 404 ? "not_found" : "unavailable", status),
        );
      await f.rebuild().creativeJobs.poll(id);
      expect(download).not.toHaveBeenCalled();
      expect(f.artifacts).toHaveLength(1);
      expect(f.messages).toMatchObject([
        { blocks: [{ kind: "file", artifactId: f.artifacts[0]!.id }] },
      ]);
      expect(f.effects[0]!.status).toBe("creative_succeeded");
      expect(f.putCount()).toBe(1);
    },
  );
  it.each(["constructor", "toString", "__proto__"])(
    "delivers opaque output ID %s once across recovery",
    async (outputId) => {
      const f = creativeFixture();
      await f.connect();
      await tool(f, "creative_submit", musicInput);
      const id = output(f, "audio/mpeg", outputId);
      f.remote.get(`account-a:${id}`)!.job.status = "unknown";
      const download = vi.spyOn(f.provider, "output");
      await f.connector.creativeJobs.poll(id);
      await f.rebuild().creativeJobs.poll(id);
      f.remote.get(`account-a:${id}`)!.job.status = "succeeded";
      await f.rebuild().creativeJobs.poll(id);
      expect(f.artifacts).toHaveLength(1);
      expect(f.messages).toMatchObject([
        { blocks: [{ kind: "file", artifactId: f.artifacts[0]!.id }] },
      ]);
      expect(download).toHaveBeenCalledTimes(1);
      expect(f.effects[0]!.status).toBe("creative_succeeded");
      expect(f.putCount()).toBe(1);
    },
  );
  it("keeps unknown partial outputs, queries for new evidence and never makes another paid intent", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    f.remote.get(`account-a:${id}`)!.job.status = "unknown";
    f.remote.get(`account-a:${id}`)!.job.errorCode = "output_incomplete";
    await f.connector.creativeJobs.poll(id);
    await f.rebuild().creativeJobs.poll(id);
    expect(f.messages).toHaveLength(1);
    expect(f.putCount()).toBe(1);
    expect(
      await f.connector.creativeJobs.result(f.context(), id, String(f.connections[0]!.providerRef)),
    ).toMatchObject({
      status: "unknown",
      errorCode: "output_incomplete",
    });
  });
  it("does not regenerate when outputs disappear or the task is hidden", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    f.remote.get(`account-a:${id}`)!.job.outputs = [];
    f.remote.get(`account-a:${id}`)!.job.errorCode = "output_unavailable";
    await f.connector.creativeJobs.poll(id);
    expect(f.artifacts).toHaveLength(0);
    expect(f.putCount()).toBe(1);
    expect(f.effects[0]!.status).toBe("creative_succeeded");
    const second = creativeFixture();
    await second.connect();
    await tool(second, "creative_submit", musicInput);
    const hidden = String(second.effects[0]!.id);
    second.hidden.add(hidden);
    await expect(second.connector.creativeJobs.poll(hidden)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(second.putCount()).toBe(1);
  });
  it("reports oversized completion without generating again", async () => {
    const f = creativeFixture();
    f.deps.maxUploadSizeBytes = 2;
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    await f.connector.creativeJobs.poll(id);
    expect(f.artifacts).toHaveLength(0);
    expect(f.messages).toHaveLength(1);
    expect(f.effects[0]!.status).toBe("creative_succeeded");
    expect(f.putCount()).toBe(1);
  });
  it("refuses background runs even when a bot owner's connection exists", async () => {
    const f = creativeFixture();
    await f.connect();
    f.runs[0]!.trigger = "routine";
    expect(await tool(f, "creative_submit", musicInput)).toMatchObject([{ type: "error" }]);
    expect(f.effects).toHaveLength(0);
    expect(f.putCount()).toBe(0);
  });
  it("cancels delivery if the connection is revoked while downloading", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = output(f);
    const original = f.provider.output.bind(f.provider);
    vi.spyOn(f.provider, "output").mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      f.connections[0]!.status = "revoked";
      return response;
    });
    await expect(f.connector.creativeJobs.poll(id)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.messages).toHaveLength(0);
    expect(f.artifacts).toHaveLength(0);
  });
  it("rejects redirects and sanitizes arbitrary remote errors", async () => {
    const f = creativeFixture();
    await f.connect();
    const identity = await credential(f);
    const fetcher = vi.fn(
      async () =>
        new Response("fake-private-upstream-detail", {
          status: 302,
          headers: { location: "https://other.example.test" },
        }),
    );
    const provider = new UserCreativeProvider(f.config, fetcher);
    await expect(provider.capabilities(identity, f.context().signal)).rejects.toEqual(
      new CreativeServiceError("unavailable", 302),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).not.toContain("fake-private-upstream-detail");
  });
  it("retains an authentication failure and resumes the same operation after login recovers", async () => {
    const f = creativeFixture();
    await f.connect();
    const submit = f.provider.submit.bind(f.provider);
    vi.spyOn(f.provider, "submit").mockImplementationOnce((...args) => {
      f.tokens.delete("fake-access-a");
      return submit(...args);
    });
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    expect(f.effects[0]!.status).toBe("creative_pending");
    expect(f.effects[0]!.result).toMatchObject({ errorCode: "authentication_required" });
    expect(f.remote.size).toBe(0);
    f.tokens.set("fake-access-a", "account-a");
    await f.rebuild().creativeJobs.poll(id);
    expect(f.remote.get(`account-a:${id}`)!.job.operationId).toBe(id);
    expect(f.putCount()).toBe(1);
  });
  it("checks pending creations after chat completion and stops local timers on shutdown", async () => {
    vi.useFakeTimers();
    const f = creativeFixture();
    try {
      await f.connect();
      f.connector.creativeJobs.start();
      await tool(f, "creative_submit", musicInput);
      const id = output(f);
      f.runs[0]!.status = "completed";
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.artifacts).toHaveLength(1);
      expect(f.messages).toHaveLength(1);
      expect(f.effects[0]!.id).toBe(id);
      expect(f.putCount()).toBe(1);
      await f.connector.creativeJobs.stop();
      const requests = f.history.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.history).toHaveLength(requests);
    } finally {
      await f.connector.creativeJobs.stop();
      vi.useRealTimers();
    }
  });
  it("aborts and drains active checks while retaining the operation for recovery", async () => {
    const f = creativeFixture();
    await f.connect();
    await tool(f, "creative_submit", musicInput);
    const id = String(f.effects[0]!.id);
    let opened = () => {};
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    vi.spyOn(f.provider, "job").mockImplementation(
      (_credential, _id, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new CreativeServiceError("unavailable")), {
            once: true,
          });
          opened();
        }),
    );
    const check = f.connector.creativeJobs.poll(id);
    await started;
    await f.connector.creativeJobs.stop();
    await check;
    expect(f.effects[0]!.id).toBe(id);
    expect(f.effects[0]!.status).toBe("creative_pending");
    expect(f.putCount()).toBe(1);
  });
});
