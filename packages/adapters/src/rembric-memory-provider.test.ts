import type { AdapterContext } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRembricProvider, prepareRembricConnection } from "./rembric-memory-provider.js";
import type * as RemoteMcp from "./remote-mcp.js";
import { callRemoteMcpTool } from "./remote-mcp.js";

vi.mock("./remote-mcp.js", async (original) => ({
  ...(await original<typeof RemoteMcp>()),
  callRemoteMcpTool: vi.fn(),
}));

const settings = {
  endpoint: "https://203.0.113.10/mcp/team-notes",
  spaceId: "space-1",
  projectId: "project-1",
};
const credentials = { token: "fake-rembric-token" };
const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const request = { botId: "bot-1", scope: "shared" as const };
const memory = {
  id: "memory-1",
  title: "Title",
  content: "A durable fact",
  projectId: "project-1",
  status: "active",
};
const envelope = (value: unknown) => ({ structuredContent: value, isError: false });
const call = vi.mocked(callRemoteMcpTool);
const provider = () => createRembricProvider(settings, credentials);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockImplementation(async (_options, name) => {
    if (name === "project.current")
      return envelope({
        slug: "team-notes",
        projectId: "project-1",
        source: "url",
        suggestedSlugs: [],
      });
    if (name === "memory.search")
      return envelope({ count: 1, memories: [memory], searchedProjects: ["team-notes"] });
    if (name === "memory.get_batch")
      return envelope({ memories: [memory], errors: [], total: 1, nextOffset: null });
    if (name === "memory.archive")
      return envelope({ ok: true, id: "memory-1", status: "archived" });
    return envelope({
      id: "memory-1",
      status: "created",
      createdAt: "2026-01-01T00:00:00Z",
      candidates: [],
      judgmentRequired: false,
      candidatesDetected: 0,
    });
  });
});

describe("Rembric shared memory", () => {
  it("advertises no isolated scope and never sends history to MCP", async () => {
    const p = provider();
    expect(p.describe().capabilities.isolatedScope).toBe(false);
    expect(
      await p.save(
        {
          ...request,
          scope: "isolated",
          content: "summary",
          source: { kind: "history", generation: 1 },
        },
        context,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(await p.purgeHistory({ botId: "bot-1", generations: [1] }, context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects every isolated durable operation without MCP", async () => {
    const p = provider();
    const isolated = { ...request, scope: "isolated" as const };
    const error = { ok: false, error: "Rembric only supports shared (Space) memory" };
    expect(
      await p.save({ ...isolated, content: "fact", source: { kind: "durable" } }, context),
    ).toEqual(error);
    expect(await p.recall({ ...isolated, query: "fact", limit: 4 }, context)).toEqual(error);
    expect(await p.forget({ ...isolated, id: "memory-1" }, context)).toEqual(error);
    expect(call).not.toHaveBeenCalled();
  });

  it("maps durable saves to strict required fields without adjudication", async () => {
    expect(
      await provider().save(
        { ...request, content: "x".repeat(120), source: { kind: "durable" } },
        context,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: settings.endpoint }),
      "memory.save",
      {
        type: "project",
        title: "x".repeat(100),
        content: "x".repeat(120),
        tags: ["rakazo"],
      },
    );
    expect(call.mock.calls.map(([, name]) => name)).toEqual(["project.current", "memory.save"]);
  });

  it("preserves search order, uses active bounded search and no invented update timestamp", async () => {
    const result = await provider().recall({ ...request, query: "fact", limit: 999 }, context);
    expect(call).toHaveBeenLastCalledWith(expect.anything(), "memory.search", {
      query: "fact",
      status: "active",
      limit: 200,
    });
    expect(result).toEqual({
      ok: true,
      value: [{ id: "memory-1", memory: memory.content, score: 0, entity: "space-space-1" }],
    });
  });

  it("confirms ownership before archiving and does not promise erasure", async () => {
    expect(await provider().forget({ ...request, id: "memory-1" }, context)).toEqual({
      ok: true,
      value: { id: "memory-1", expired: true, reason: null },
    });
    expect(call.mock.calls.map(([, name, args]) => [name, args])).toEqual([
      ["project.current", {}],
      ["memory.get_batch", { ids: ["memory-1"] }],
      ["memory.archive", { id: "memory-1" }],
    ]);
  });

  it("rejects foreign ids with an otherwise valid control and conflicting entities", async () => {
    const p = provider();
    expect((await p.forget({ ...request, id: "memory-1" }, context)).ok).toBe(true);
    call.mockClear();
    call
      .mockResolvedValueOnce(
        envelope({
          slug: "team-notes",
          projectId: "project-1",
          source: "url",
          suggestedSlugs: [],
        }),
      )
      .mockResolvedValueOnce(
        envelope({
          memories: [{ ...memory, projectId: "foreign" }],
          errors: [],
          total: 1,
          nextOffset: null,
        }),
      );
    expect((await p.forget({ ...request, id: "memory-1" }, context)).ok).toBe(false);
    expect(call.mock.calls.some(([, name]) => name === "memory.archive")).toBe(false);
    call.mockClear();
    expect((await p.forget({ ...request, id: "memory-1", entity: "foreign" }, context)).ok).toBe(
      false,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { isError: true, structuredContent: { message: "secret-token" } },
    { truncated: true, content: "secret-token" },
    envelope({ count: 1, memories: [{ ...memory, projectId: "foreign" }] }),
    envelope({ count: 1, memories: [{ ...memory, projectId: undefined }] }),
    envelope({ count: 2, memories: [memory] }),
    envelope({ count: 1, memories: [{ ...memory, status: "archived" }] }),
  ])("fails closed on unsafe search payloads without echoing remote content", async (payload) => {
    call
      .mockResolvedValueOnce(
        envelope({
          slug: "team-notes",
          projectId: "project-1",
          source: "url",
          suggestedSlugs: [],
        }),
      )
      .mockResolvedValueOnce(payload);
    const result = await provider().recall({ ...request, query: "fact", limit: 4 }, context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("preserves multiple ranked results without fabricating timestamps or similarity", async () => {
    const second = {
      ...memory,
      id: "memory-2",
      content: "Second fact",
      createdAt: "2026-01-01",
      lastSeenAt: "2026-02-01",
    };
    const implementation = call.getMockImplementation()!;
    call.mockImplementation(async (options, name, args) =>
      name === "memory.search"
        ? envelope({ count: 2, memories: [second, memory] })
        : implementation(options, name, args),
    );
    const result = await provider().recall({ ...request, query: "fact", limit: 2 }, context);
    expect(result).toEqual({
      ok: true,
      value: [
        { id: "memory-2", memory: "Second fact", score: 0, entity: "space-space-1" },
        { id: "memory-1", memory: memory.content, score: 0, entity: "space-space-1" },
      ],
    });
  });

  it.each([
    {
      memories: [memory],
      errors: [{ id: "memory-1", message: "secret-token" }],
      total: 1,
      nextOffset: null,
    },
    { memories: [{ ...memory, id: "different" }], errors: [], total: 1, nextOffset: null },
    { memories: [{ ...memory, truncated: true }], errors: [], total: 1, nextOffset: null },
    { memories: [memory], errors: [], total: 2, nextOffset: 1 },
  ])("never archives after an incomplete or invalid ownership response", async (batch) => {
    const implementation = call.getMockImplementation()!;
    call.mockImplementation(async (options, name, args) =>
      name === "memory.get_batch" ? envelope(batch) : implementation(options, name, args),
    );
    expect((await provider().forget({ ...request, id: "memory-1" }, context)).ok).toBe(false);
    expect(call.mock.calls.some(([, name]) => name === "memory.archive")).toBe(false);
  });

  it.each(["memory.save", "memory.archive"])(
    "rejects malformed or error output for %s",
    async (verb) => {
      const implementation = call.getMockImplementation()!;
      call.mockImplementation(async (options, name, args) =>
        name === verb
          ? { isError: true, structuredContent: { message: "secret-token" } }
          : implementation(options, name, args),
      );
      const p = provider();
      const result =
        verb === "memory.save"
          ? await p.save({ ...request, content: "fact", source: { kind: "durable" } }, context)
          : await p.forget({ ...request, id: "memory-1" }, context);
      expect(result).toEqual({
        ok: false,
        error: "Rembric request failed or returned an invalid response.",
      });
    },
  );

  it("leaves save candidates for semantic judgment without extra calls", async () => {
    const implementation = call.getMockImplementation()!;
    call.mockImplementation(async (options, name, args) =>
      name === "memory.save"
        ? envelope({
            id: "memory-1",
            status: "active",
            createdAt: "2026-01-01",
            judgmentRequired: true,
            candidatesDetected: 1,
            candidates: [
              {
                judgmentId: "judgment-1",
                targetId: "memory-2",
                title: "Other",
                snippet: "Other fact",
                similarity: 0.9,
                source: "vec",
                topicKey: null,
              },
            ],
          })
        : implementation(options, name, args),
    );
    expect(
      (await provider().save({ ...request, content: "fact", source: { kind: "durable" } }, context))
        .ok,
    ).toBe(true);
    expect(call.mock.calls.map(([, name]) => name)).toEqual(["project.current", "memory.save"]);
  });

  it("sanitizes transport errors", async () => {
    call.mockRejectedValueOnce(new Error("secret-token https://private.example"));
    expect(await provider().recall({ ...request, query: "fact", limit: 4 }, context)).toEqual({
      ok: false,
      error: "Rembric request failed or returned an invalid response.",
    });
  });

  it("rejects a runtime Space mismatch without network access", async () => {
    expect(
      (
        await provider().recall(
          { ...request, query: "fact", limit: 1 },
          { ...context, spaceId: "other" },
        )
      ).ok,
    ).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("prepares by checking actual project access without writes and persists trusted binding", async () => {
    const prepared = await prepareRembricConnection({ endpoint: settings.endpoint }, credentials, {
      spaceId: "space-1",
    });
    expect(prepared).toEqual({ settings, credentials });
    expect(call.mock.calls.map(([, name]) => name)).toEqual(["project.current"]);
  });

  it.each([undefined, "other"])(
    "rejects missing or mismatched trusted Space %s",
    async (spaceId) => {
      await expect(prepareRembricConnection(settings, credentials, { spaceId })).rejects.toThrow();
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("sanitizes credential-probe errors and explains the access requirement", async () => {
    call.mockRejectedValueOnce(new Error("secret-token https://private.example"));
    await expect(
      prepareRembricConnection({ endpoint: settings.endpoint }, credentials, {
        spaceId: "space-1",
      }),
    ).rejects.toThrow(
      "Rembric project access could not be verified; check the endpoint, pre-created Space project and token.",
    );
  });

  it.each([
    "https://fake-user:fake-password@203.0.113.10/mcp/team-notes",
    "http://203.0.113.10/mcp/team-notes",
    "https://169.254.169.254/mcp/team-notes",
    "https://metadata.google.internal/mcp/team-notes",
  ])("never probes credentials at an unsafe endpoint %s", async (endpoint) => {
    await expect(
      prepareRembricConnection({ endpoint }, credentials, {
        spaceId: "space-1",
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([null, "foreign"])("rejects missing/wrong project access %s", async (projectId) => {
    call.mockResolvedValueOnce(
      envelope({
        slug: projectId ? "foreign" : null,
        projectId,
        source: "url",
        suggestedSlugs: [],
      }),
    );
    await expect(
      prepareRembricConnection({ endpoint: settings.endpoint }, credentials, {
        spaceId: "space-1",
      }),
    ).rejects.toThrow();
  });

  it.each([
    "/mcp",
    "/mcp/Bad_slug",
    "/mcp/-notes",
    "/mcp/notes-",
    `/mcp/${"a".repeat(65)}`,
    "/mcp/%6eotes",
    "/mcp/team-notes?token=x",
    "/mcp/team-notes#",
    "/mcp/team-notes/extra",
  ])("rejects ambiguous or wrong endpoint path %s", async (path) => {
    await expect(
      prepareRembricConnection({ endpoint: `https://203.0.113.10${path}` }, credentials, {
        spaceId: "space-1",
      }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("requires explicit approval for local deployment and preserves its scoped path", async () => {
    const local = { endpoint: "http://127.0.0.1:8123/mcp/team-notes" };
    await expect(
      prepareRembricConnection(local, credentials, {
        spaceId: "space-1",
        allowPrivateEndpoint: false,
      }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    const prepared = await prepareRembricConnection(local, credentials, {
      spaceId: "space-1",
      allowPrivateEndpoint: true,
    });
    expect(prepared.settings.endpoint).toBe(local.endpoint);
    expect(prepared.settings.endpointTrust).toBe("private");
  });
});
