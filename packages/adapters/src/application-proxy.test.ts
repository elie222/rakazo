import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { applicationForwardSecret } from "./application-proxy.js";
import { loadConfiguredApps } from "./configured-apps.js";
import { capabilities, creativeFixture, musicInput } from "./creative.test-support.js";
import { ConnectorRegistry } from "./integrations/connector-registry.js";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const f = creativeFixture();
  f.runs[0]!.leaseExpiresAt = new Date(Date.now() + 60_000);
  const env = {
    APP_CONNECTIONS: JSON.stringify({ creative: f.config }),
    APP_INTERNAL_URL: "http://internal.example.test",
    ENCRYPTION_KEY: "fake-existing-encryption-key",
  };
  const internal: string[] = [];
  const responses: string[] = [];
  let loseResponse = false;
  vi.stubGlobal("fetch", async (url: string | URL | Request, options?: RequestInit) => {
    if (new URL(String(url)).origin !== env.APP_INTERNAL_URL) return f.fetcher(url, options);
    internal.push(String(options?.body));
    const response = await host.handle(new Request(url, options), "creative");
    responses.push(await response.clone().text());
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Synthetic lost proxy response");
    }
    return response;
  });
  const host = await loadConfiguredApps({
    ...f.deps,
    env,
    credentials: async (userId) => {
      return f.identities.get(userId) ?? null;
    },
  });
  const actor = {
    userId: "user-a",
    spaceId: "space-a",
    email: "demo@example.test",
    isDeploymentOwner: false,
  };
  host.initialize(actor);
  await vi.waitFor(() => expect(f.connections[0]?.status).toBe("connected"));
  const worker = await loadConfiguredApps({ ...f.deps, env });
  const registry = new ConnectorRegistry(worker.connectors);
  const context = f.context();
  const tools = await registry.discoverTools(context);
  const submit = tools.find((tool) => tool.route?.toolName === "creative_submit")!;
  const call: ConnectorCall = {
    tool: submit.name,
    route: submit.route,
    args: musicInput,
    executionId: "execution-a",
  };
  const execute = async () => {
    const events = [];
    for await (const event of registry.execute(call, context)) events.push(event);
    return events;
  };
  const body = (changes = {}) =>
    JSON.stringify({
      action: "execute",
      context: {
        ...Object.fromEntries(
          ["userId", "spaceId", "botId", "runId", "operationId", "traceId"].map((key) => [
            key,
            context[key as keyof AdapterContext],
          ]),
        ),
        connectionIds: [f.connections[0]!.id],
      },
      call,
      ...changes,
    });
  const request = (body: string, auth = `Bearer ${applicationForwardSecret(env)}`) =>
    host.handle(
      new Request("http://internal.example.test/internal/apps/creative", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body,
      }),
      "creative",
    );
  return {
    f,
    host,
    worker,
    registry,
    context,
    tools,
    call,
    internal,
    responses,
    body,
    request,
    execute,
    loseNextResponse: () => {
      loseResponse = true;
    },
    stop: async () => {
      await worker.stop();
      await host.stop();
    },
  };
}

it("forwards normal tool discovery and execution without sending user credentials to the worker", async () => {
  const t = await fixture();
  try {
    expect(t.tools).toHaveLength(3);
    expect(await t.registry.resolveCall(t.call, t.context)).toBeUndefined();
    expect(await t.execute()).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    expect(t.f.putCount()).toBe(1);
    for (const text of [...t.internal, ...t.responses]) {
      expect(text).not.toContain("fake-access-a");
      expect(text).not.toContain("accessToken");
      expect(text).not.toContain("refreshToken");
      expect(text).not.toContain("BETTER_AUTH_SECRET");
      expect(text).not.toContain("OIDC_CLIENT_SECRET");
    }
  } finally {
    await t.stop();
  }
});

it("does not retry a lost paid response; the same execution recovers the original operation", async () => {
  const t = await fixture();
  try {
    const before = t.internal.length;
    t.loseNextResponse();
    await expect(t.execute()).rejects.toThrow("Connected application unavailable");
    expect(t.internal.length).toBe(before + 1);
    const operationId = t.f.effects[0]!.id;
    expect(await t.execute()).toMatchObject([{ type: "result", data: { operationId } }]);
    expect(t.f.effects).toHaveLength(1);
    expect(t.f.putCount()).toBe(1);
  } finally {
    await t.stop();
  }
});

it("forwards selected parameters through the generic worker transport unchanged", async () => {
  const t = await fixture();
  try {
    t.f.setCatalog({ ...capabilities, submission: { presetOnly: false, referenceMedia: false } });
    const parameters = { resolution: "1080P", seconds: 10, watermark: false, seed: 0 };
    t.call.args = {
      kind: "video",
      model: "demo-video",
      preset: "demo-video-default",
      prompt: "Offline video",
      parameters,
    };
    expect(await t.execute()).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    const execute = t.internal
      .map((body) => JSON.parse(body))
      .find((request) => request.action === "execute");
    expect(execute.call.args.parameters).toEqual(parameters);
    expect(t.f.history.find((request) => request.method === "PUT")!.input).toMatchObject({
      parameters,
    });
    expect(t.f.putCount()).toBe(1);
  } finally {
    await t.stop();
  }
});

it("forwards only selected attachment IDs while the API uploads original image bytes", async () => {
  const t = await fixture();
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
      "base64",
    );
    t.f.artifacts.push({
      id: "selected-image",
      userId: "user-a",
      spaceId: "space-a",
      botId: "bot-a",
      groupId: null,
      mimeType: "image/png",
      storageKey: "selected-blob",
      size: bytes.byteLength,
      hash: String(bytes.byteLength),
    });
    t.f.blobs.get = vi.fn(async () => new Uint8Array(bytes));
    t.f.setCatalog({
      ...capabilities,
      models: capabilities.models.map((model) => ({
        ...model,
        inputs: { referenceImages: model.kind === "image" },
      })),
      submission: {
        presetOnly: false,
        referenceMedia: true,
        referenceKinds: ["image"],
        maxReferenceImageBytes: 1_000,
      },
    });
    t.call.args = {
      kind: "image",
      model: "demo-image",
      preset: "demo-image-default",
      prompt: "Edit the selected picture",
      referenceArtifactIds: ["selected-image"],
    };
    expect(await t.execute()).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    expect(t.f.referenceUploads).toHaveLength(1);
    expect(Buffer.from(t.f.referenceUploads[0]!.bytes)).toEqual(bytes);
    for (const request of t.internal) expect(request).not.toContain(bytes.toString("base64"));
    expect(t.f.history.find((request) => request.method === "PUT")!.input).toMatchObject({
      references: [...t.f.references.keys()],
    });
    expect(t.f.putCount()).toBe(1);
  } finally {
    await t.stop();
  }
});

it("rejects missing authentication and arbitrary destinations before calling the app", async () => {
  const t = await fixture();
  try {
    const unauthenticated = await t.request(t.body(), "");
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe("");
    expect((await t.request(t.body({ url: "https://arbitrary.example.test" }))).status).toBe(400);
    expect((await t.request(t.body({ action: "get-token" }))).status).toBe(400);
    expect((await t.request("x".repeat(1_000_001))).status).toBe(413);
    expect(t.f.putCount()).toBe(0);
  } finally {
    await t.stop();
  }
});

it("keeps video/audio bytes on the API side of the generic worker transport", async () => {
  const t = await fixture();
  try {
    const video = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112]);
    const audio = Buffer.from("RIFFsynthetic audio");
    for (const [id, bytes, mimeType] of [
      ["clip", video, "video/mp4"],
      ["sound", audio, "audio/wav"],
    ] as const)
      t.f.artifacts.push({
        id,
        userId: "user-a",
        spaceId: "space-a",
        botId: "bot-a",
        groupId: null,
        mimeType,
        storageKey: id,
        size: bytes.byteLength,
        hash: String(bytes.byteLength),
      });
    t.f.blobs.get = vi.fn(async (id) => new Uint8Array(id === "clip" ? video : audio));
    t.f.setCatalog({
      ...capabilities,
      models: capabilities.models.map((model) => ({
        ...model,
        inputs: {
          referenceImages: true,
          referenceVideos: model.kind === "video",
          referenceAudios: model.kind === "video",
        },
      })),
      submission: {
        presetOnly: false,
        referenceMedia: true,
        referenceKinds: ["image", "video", "audio"],
        maxReferenceMediaBytes: 1_000,
        maxReferenceImageBytes: 1_000,
      },
    });
    t.call.args = {
      kind: "video",
      model: "demo-video",
      preset: "demo-video-default",
      prompt: "Follow the selected clip and audio",
      parameters: { mode: "reference" },
      referenceArtifactIds: ["sound", "clip"],
    };
    expect(await t.execute()).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    expect(t.f.referenceUploads.map((item) => Buffer.from(item.bytes))).toEqual([audio, video]);
    for (const request of t.internal) {
      expect(request).not.toContain(video.toString("base64"));
      expect(request).not.toContain(audio.toString("base64"));
      expect(request).not.toContain("fake-access-a");
    }
    expect(t.f.history.find((item) => item.method === "PUT")!.input).toMatchObject({
      references: [...t.f.references.keys()],
    });
    expect(t.f.putCount()).toBe(1);
  } finally {
    await t.stop();
  }
});

it("requires the current user, space, bot, live run lease, membership and exact connection", async () => {
  const t = await fixture();
  try {
    const original = JSON.parse(t.body());
    for (const change of [
      { userId: "user-b" },
      { spaceId: "space-b" },
      { botId: "bot-b" },
      { runId: "run-b" },
      { connectionIds: ["foreign-connection"] },
    ]) {
      expect(
        (await t.request(t.body({ context: { ...original.context, ...change } }))).status,
      ).toBe(403);
    }
    t.f.runs[0]!.leaseExpiresAt = new Date(0);
    expect((await t.request(t.body())).status).toBe(403);
    t.f.runs[0]!.leaseExpiresAt = new Date(Date.now() + 60_000);
    t.f.runs[0]!.status = "completed";
    expect((await t.request(t.body())).status).toBe(403);
    t.f.runs[0]!.status = "running";
    t.f.members.delete("space-a:user-a");
    expect((await t.request(t.body())).status).toBe(403);
    t.f.members.add("space-a:user-a");
    t.f.connections[0]!.status = "revoked";
    expect((await t.request(t.body())).status).toBe(403);
    expect(t.f.putCount()).toBe(0);
  } finally {
    await t.stop();
  }
});
