import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MAX_HONCHO_CONCLUSION_BYTES } from "./honcho-client.js";
import {
  createHonchoProvider,
  HonchoMemoryProvider,
  honchoRequiresDeploymentOwner,
  honchoWorkspaceId,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";
import type { ResolveHostname } from "./network-address.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

/** Honcho's DialecticResponse.content is `str | None`. */
type DialecticContent = string | null;

function honchoFetch(
  chatAnswers?: Record<string, DialecticContent>,
  workspaces = ["rakazo-space-1"],
  readOnlyPeers: string[] = [],
) {
  const facts = new Map<string, string[]>();
  const peers = new Set(["rakazo-shared", "bot-bot-1", "bot-bot-2"]);
  const readable = new Set([...peers, ...readOnlyPeers]);
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    expect(new URL(String(url)).origin).toBe("https://api.honcho.dev");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    const route = path.match(
      /^\/v3\/workspaces\/([^/]+)\/(peers(?:\/([^/]+)\/chat)?|conclusions)$/,
    );
    const workspace = route?.[1];
    if (workspace) expect(workspaces).toContain(workspace);
    const peer = route?.[3];
    let content: DialecticContent | undefined;
    if (peer) {
      // DialecticOptions.query: max_length=10000 code points, else 422.
      if ([...body.query].length > 10_000) return new Response("{}", { status: 422 });
      expect(readable.has(peer)).toBe(true);
      expect(body).toEqual({
        query: expect.any(String),
        reasoning_level: "low",
        stream: false,
        ...(peer === "rakazo-shared" || !peers.has(peer) ? {} : { target: "rakazo-shared" }),
      });
      if (chatAnswers) {
        if (!Object.hasOwn(chatAnswers, peer)) throw new Error(`Unexpected chat: ${path}`);
        content = chatAnswers[peer];
      } else {
        content =
          facts.get(JSON.stringify([workspace, peer, body.target ?? peer]))?.join("\n") ||
          "NO_RELEVANT_MEMORY";
      }
    } else if (path === "/v3/workspaces") {
      expect(body).toEqual({ id: expect.any(String) });
      expect(workspaces).toContain(body.id);
    } else if (route?.[2] === "peers") {
      expect(body).toEqual({ id: expect.any(String) });
      expect(peers.has(body.id)).toBe(true);
    } else if (route?.[2] === "conclusions") {
      expect(body).toEqual({ conclusions: expect.any(Array) });
      for (const conclusion of body.conclusions) {
        expect(conclusion).toEqual({
          content: expect.any(String),
          observer_id: expect.any(String),
          observed_id: "rakazo-shared",
        });
        expect(peers.has(conclusion.observer_id)).toBe(true);
        const key = JSON.stringify([workspace, conclusion.observer_id, conclusion.observed_id]);
        const saved = facts.get(key) ?? [];
        facts.set(key, [...saved, conclusion.content]);
      }
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return new Response(JSON.stringify(peer ? { content } : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function provider(fetch: typeof globalThis.fetch, settings: Record<string, string> = {}) {
  return new HonchoMemoryProvider(
    { baseUrl: "https://api.honcho.dev", apiKey: "hch-test", reasoningLevel: "low", fetch },
    settings,
  );
}

function calls(fetchMock: ReturnType<typeof honchoFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: new URL(String(url)).pathname,
    body: JSON.parse(String(init?.body)),
  }));
}

describe("HonchoMemoryProvider", () => {
  it("saves shared facts for the Space and the bot, then recalls through peer chat", async () => {
    const fetchMock = honchoFetch({
      "rakazo-shared": "The user's favorite color is teal.",
      "bot-bot-1": "NO_RELEVANT_MEMORY",
    });
    const memory = provider(fetchMock);

    const saved = await memory.save(
      {
        content: "Favorite color is teal",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    const recalled = await memory.recall(
      { query: "what color should the deck be?", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(saved).toEqual({ ok: true, value: undefined });
    const conclusions = calls(fetchMock).find((call) => call.path.endsWith("/conclusions"));
    expect(conclusions).toEqual({
      path: "/v3/workspaces/rakazo-space-1/conclusions",
      body: {
        conclusions: [
          {
            content: "Favorite color is teal",
            observer_id: "bot-bot-1",
            observed_id: "rakazo-shared",
          },
          {
            content: "Favorite color is teal",
            observer_id: "rakazo-shared",
            observed_id: "rakazo-shared",
          },
        ],
      },
    });
    const chats = calls(fetchMock).filter((call) => call.path.endsWith("/chat"));
    expect(chats.map((call) => [call.path, call.body.target])).toEqual([
      ["/v3/workspaces/rakazo-space-1/peers/rakazo-shared/chat", undefined],
      ["/v3/workspaces/rakazo-space-1/peers/bot-bot-1/chat", "rakazo-shared"],
    ]);
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The user's favorite color is teal.",
          score: 1,
          provenance: "honcho",
          entity: "rakazo-shared",
        },
      ],
    });
    // Workspace and peers are get-or-create once per provider, not per call.
    expect(calls(fetchMock).filter((call) => call.path.endsWith("/peers"))).toHaveLength(2);
  });

  it("shares facts across members while keeping isolated facts per bot across users and routines", async () => {
    const fetch = honchoFetch();
    const memory = provider(fetch);
    const otherMember = { ...context, userId: "user-2", botId: "bot-2" };
    const save = (content: string, scope: "shared" | "isolated") =>
      memory.save({ content, scope, botId: "bot-1", source: { kind: "durable" } }, context);
    expect(await save("The Space uses teal", "shared")).toEqual({ ok: true, value: undefined });
    expect(await save("Bot A's private fact", "isolated")).toEqual({ ok: true, value: undefined });

    const recall = { query: "facts?", scope: "shared" as const, botId: "bot-2", limit: 5 };
    // Bot B sees user 1's shared fact, but never bot A's private fact.
    expect(await memory.recall(recall, otherMember)).toMatchObject({
      ok: true,
      value: [{ memory: "The Space uses teal", entity: "rakazo-shared" }],
    });
    expect(await memory.recall({ ...recall, scope: "isolated" }, otherMember)).toEqual({
      ok: true,
      value: [],
    });
    // A bot's private memory follows the bot across members and userless routines.
    for (const userId of ["user-1", "user-2", ""]) {
      const botContext = { ...context, userId };
      expect(
        await memory.recall({ ...recall, scope: "isolated", botId: "bot-1" }, botContext),
      ).toMatchObject({
        ok: true,
        value: [{ memory: "The Space uses teal\nBot A's private fact", entity: "bot-bot-1" }],
      });
      expect(await memory.recall(recall, { ...otherMember, userId })).toMatchObject({
        ok: true,
        value: [{ memory: "The Space uses teal", entity: "rakazo-shared" }],
      });
    }
    expect(
      await memory.save(
        { content: "Routine fact", scope: "shared", botId: "bot-2", source: { kind: "durable" } },
        { ...otherMember, userId: "" },
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(await memory.recall({ ...recall, botId: "bot-1" }, context)).toMatchObject({
      ok: true,
      value: [
        { memory: "The Space uses teal\nRoutine fact", entity: "rakazo-shared" },
        { memory: "The Space uses teal\nBot A's private fact", entity: "bot-bot-1" },
      ],
    });
  });

  it.each([true, false])(
    "shares facts across Spaces only with an explicit shared workspace (configured: %s)",
    async (configured) => {
      const workspaces = configured ? ["team-notes"] : ["rakazo-space-1", "rakazo-space-2"];
      const fetch = honchoFetch(undefined, workspaces);
      const settings: Record<string, string> = configured ? { workspaceId: "team-notes" } : {};
      const spaceA = provider(fetch, settings);
      const spaceB = provider(fetch, settings);
      const otherSpace = { ...context, spaceId: "space-2", userId: "user-2", botId: "bot-2" };
      for (const scope of ["shared", "isolated"] as const) {
        expect(
          await spaceA.save(
            { content: `${scope} fact`, scope, botId: "bot-1", source: { kind: "durable" } },
            context,
          ),
        ).toEqual({ ok: true, value: undefined });
      }
      expect(
        await spaceB.recall(
          { query: "facts?", scope: "shared", botId: "bot-2", limit: 5 },
          otherSpace,
        ),
      ).toEqual({
        ok: true,
        value: configured
          ? [{ memory: "shared fact", score: 1, provenance: "honcho", entity: "rakazo-shared" }]
          : [],
      });
      expect(
        await spaceB.recall(
          { query: "facts?", scope: "isolated", botId: "bot-2", limit: 5 },
          otherSpace,
        ),
      ).toEqual({ ok: true, value: [] });
      expect(
        calls(fetch)
          .filter((call) => call.path === "/v3/workspaces")
          .map((call) => call.body.id),
      ).toEqual(configured ? ["team-notes", "team-notes"] : workspaces);
    },
  );

  it("recalls with a prompt longer than Honcho's query limit", async () => {
    const fetchMock = honchoFetch({ "bot-bot-1": "Use metric units." });
    const result = await provider(fetchMock).recall(
      { query: "😀".repeat(20_000), scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );
    expect(result).toMatchObject({ ok: true, value: [{ memory: "Use metric units." }] });
    const [chat] = calls(fetchMock).filter((call) => call.path.endsWith("/chat"));
    expect(chat!.body.query).toContain("Request: 😀");
    expect(chat!.body.query).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("treats a dialectic with no answer as no memory", async () => {
    const result = await provider(honchoFetch({ "bot-bot-1": null })).recall(
      { query: "anything", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("caps saved conclusions by bytes so CJK text stays within the embedding limit", async () => {
    const fetchMock = honchoFetch({});
    const content = "记".repeat(MAX_HONCHO_CONCLUSION_BYTES);
    await expect(
      provider(fetchMock).save(
        { content, scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    const saved = calls(fetchMock).find((call) => call.path.endsWith("/conclusions"));
    const conclusion: string = saved!.body.conclusions[0].content;
    expect(Buffer.byteLength(conclusion)).toBeLessThanOrEqual(MAX_HONCHO_CONCLUSION_BYTES);
    expect(content.startsWith(conclusion)).toBe(true);
  });

  it("keeps compaction summaries out of Honcho", async () => {
    const fetchMock = honchoFetch({});
    const result = await provider(fetchMock).save(
      {
        content: "summary",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "history", generation: 1 },
      },
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("existing Honcho user peer", () => {
  const settings = { workspaceId: "existing-app", userPeerId: "user-alex" };

  it.each(["shared", "isolated"] as const)(
    "recalls what Honcho already knows about the user in %s scope",
    async (scope) => {
      const fetchMock = honchoFetch(
        {
          "rakazo-shared": "NO_RELEVANT_MEMORY",
          "bot-bot-1": "NO_RELEVANT_MEMORY",
          "user-alex": "Prefers short morning briefings.",
        },
        ["existing-app"],
        ["user-alex"],
      );
      const recalled = await provider(fetchMock, settings).recall(
        { query: "plan my morning", scope, botId: "bot-1", limit: 5 },
        context,
      );

      expect(recalled).toEqual({
        ok: true,
        value: [
          {
            memory: "Prefers short morning briefings.",
            score: 1,
            provenance: "honcho",
            entity: "user-alex",
          },
        ],
      });
      const userChat = calls(fetchMock).find((call) => call.path.endsWith("/user-alex/chat"));
      expect(userChat?.path).toBe("/v3/workspaces/existing-app/peers/user-alex/chat");
      expect(userChat?.body.target).toBeUndefined();
      expect(userChat?.body.query).toContain("what you know about the user");
    },
  );

  it("never creates or writes to the user peer", async () => {
    const fetchMock = honchoFetch({ "user-alex": "A fact" }, ["existing-app"], ["user-alex"]);
    const memory = provider(fetchMock, settings);
    await memory.save(
      { content: "Bot fact", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    await memory.recall({ query: "q", scope: "isolated", botId: "bot-1", limit: 5 }, context);

    for (const call of calls(fetchMock)) {
      if (call.path.endsWith("/peers")) expect(call.body.id).not.toBe("user-alex");
      if (call.path.endsWith("/conclusions")) {
        for (const conclusion of call.body.conclusions) {
          expect(conclusion.observer_id).not.toBe("user-alex");
          expect(conclusion.observed_id).not.toBe("user-alex");
        }
      }
    }
  });

  it("keeps the Space's own memory when the user peer cannot be read", async () => {
    const normal = honchoFetch({ "bot-bot-1": "A bot fact" }, ["existing-app"], ["user-alex"]);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/user-alex/chat")) return new Response("", { status: 404 });
      return normal(url, init);
    });
    await expect(
      provider(fetch, settings).recall(
        { query: "q", scope: "isolated", botId: "bot-1", limit: 5 },
        context,
      ),
    ).resolves.toMatchObject({ ok: true, value: [{ memory: "A bot fact", entity: "bot-bot-1" }] });
  });
});

describe("shared recall deduplication", () => {
  it.each([1, 5])("keeps the first answer before applying limit %i", async (limit) => {
    const result = await provider(
      honchoFetch({
        "rakazo-shared": "Favorite color is teal.",
        "bot-bot-1": "  FAVORITE  color\nis teal.  ",
      }),
    ).recall({ query: "color?", scope: "shared", botId: "bot-1", limit }, context);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Favorite color is teal.",
          score: 1,
          provenance: "honcho",
          entity: "rakazo-shared",
        },
      ],
    });
  });
});

function connectionFetch(path: string, body: unknown, status = 200) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`https://api.honcho.dev${path}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer hch-test-key" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response("", { status });
  });
}

describe("prepareHonchoConnection", () => {
  it("probes an admin key without creating a workspace and derives per-Space workspaces", async () => {
    const fetch = connectionFetch("/v3/workspaces/list?size=1", {});
    const prepared = await prepareHonchoConnection(
      { apiKey: "discard", baseUrl: "http://localhost" },
      { apiKey: " hch-test-key " },
      { fetch },
    );
    expect(prepared).toEqual({
      settings: { reasoningLevel: "low" },
      credentials: { apiKey: "hch-test-key" },
    });
    expect(honchoWorkspaceId(prepared.settings, "space-1")).toBe("rakazo-space-1");
    expect(honchoWorkspaceId(prepared.settings, "space-2")).toBe("rakazo-space-2");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates an explicit workspace and saves only normalized public settings", async () => {
    const fetch = connectionFetch("/v3/workspaces", { id: "team-notes" });
    const prepared = await prepareHonchoConnection(
      { workspaceId: " team-notes ", reasoningLevel: "medium", apiKey: "discard" },
      { apiKey: " hch-test-key " },
      { fetch },
    );
    expect(prepared).toEqual({
      settings: { workspaceId: "team-notes", reasoningLevel: "medium" },
      credentials: { apiKey: "hch-test-key" },
    });
    expect(honchoWorkspaceId(prepared.settings, "space-1")).toBe("team-notes");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("rejects status %i for either workspace branch", async (status) => {
    for (const workspaceId of ["", "team-notes"]) {
      const fetch = connectionFetch(
        workspaceId ? "/v3/workspaces" : "/v3/workspaces/list?size=1",
        workspaceId ? { id: workspaceId } : {},
        status,
      );
      await expect(
        prepareHonchoConnection({ workspaceId }, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow(`Honcho request failed: ${status}`);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("saves an existing user peer with its workspace", async () => {
    const fetch = connectionFetch("/v3/workspaces", { id: "existing-app" });
    const prepared = await prepareHonchoConnection(
      { workspaceId: "existing-app", userPeerId: " user-alex " },
      { apiKey: "hch-test-key" },
      { fetch },
    );
    expect(prepared.settings).toEqual({
      workspaceId: "existing-app",
      userPeerId: "user-alex",
      reasoningLevel: "low",
    });
  });

  it.each([
    [{ userPeerId: "user-alex" }, /requires the workspace/],
    [{ workspaceId: "existing-app", userPeerId: "bad peer" }, /userPeerId/],
    [{ workspaceId: "existing-app", userPeerId: "rakazo-shared" }, /reserved/],
    [{ workspaceId: "existing-app", userPeerId: "bot-bot_1" }, /reserved/],
  ])("rejects an invalid user peer before probing", async (settings, error) => {
    const fetch = vi.fn(() => {
      throw new Error("Unexpected request");
    });
    await expect(
      prepareHonchoConnection(settings, { apiKey: "hch-test-key" }, { fetch }),
    ).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["bad workspace", "../private", "a".repeat(513)])(
    "rejects invalid workspace names before probing",
    async (workspaceId) => {
      const fetch = vi.fn(() => {
        throw new Error("Unexpected request");
      });
      await expect(
        prepareHonchoConnection({ workspaceId }, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow(/workspaceId/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "short", "k".repeat(4097)])(
    "rejects invalid key length before probing",
    async (apiKey) => {
      const fetch = vi.fn(() => {
        throw new Error("Unexpected request");
      });
      await expect(prepareHonchoConnection({}, { apiKey }, { fetch })).rejects.toThrow(/apiKey/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "timeout"])(
    "handles %s failures without reflecting exception secrets",
    async (kind) => {
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (kind === "timeout") {
          throw new DOMException("hch-test-key" + "x".repeat(5000), "TimeoutError");
        }
        throw new Error("hch-test-key" + "x".repeat(5000));
      });
      await expect(
        prepareHonchoConnection({}, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow("Honcho is unreachable or the request timed out.");
    },
  );
});

describe("Honcho scope and failures", () => {
  const recall = { query: "color?", scope: "shared" as const, botId: "bot-1", limit: 1 };
  it("applies the recall limit to distinct answers", async () => {
    const result = await provider(
      honchoFetch({ "rakazo-shared": "First fact", "bot-bot-1": "Second fact" }),
    ).recall(recall, context);
    expect(result).toMatchObject({ ok: true, value: [{ memory: "First fact" }] });
  });
  it("keeps isolated saves and recalls in the bot perspective", async () => {
    const fetch = honchoFetch({ "bot-bot-1": "A private fact" });
    const memory = provider(fetch);
    await memory.save(
      { content: " fact ", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    const saved = calls(fetch).find((call) => call.path.endsWith("/conclusions"));
    expect(saved?.body.conclusions).toEqual([
      { content: "fact", observer_id: "bot-bot-1", observed_id: "rakazo-shared" },
    ]);
    await memory.recall({ ...recall, scope: "isolated" }, context);
    expect(calls(fetch).filter((call) => call.path.endsWith("/chat"))).toHaveLength(1);
  });
  it("returns recall errors as results and retries failed peer setup", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== "https://api.honcho.dev/v3/workspaces")
        throw new Error("Unexpected request");
      return new Response("", { status: 503 });
    });
    const memory = provider(fetch);
    await expect(memory.recall(recall, context)).resolves.toEqual({
      ok: false,
      error: "Honcho request failed: 503",
    });
    await memory.recall(recall, context);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps successful shared recall when another perspective fails", async () => {
    const normal = honchoFetch({ "rakazo-shared": "A fact" });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/bot-bot-1/chat")) return new Response("", { status: 503 });
      return normal(url, init);
    });
    await expect(provider(fetch).recall(recall, context)).resolves.toMatchObject({
      ok: true,
      value: [{ memory: "A fact" }],
    });
  });
});

describe("Honcho local mode", () => {
  const LOCAL_URL = "http://honcho-api.railway.internal:8000";
  const privateResolver: ResolveHostname = async () => [{ address: "fd12:3456::7", family: 6 }];
  const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];
  const save = {
    content: "Prefers short answers.",
    scope: "isolated" as const,
    botId: "bot-1",
    source: { kind: "durable" as const },
  };

  function localFetch() {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).origin).toBe(LOCAL_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer honcho-admin-token");
      return Response.json({});
    });
  }

  it("requires the deployment owner for every mode except Honcho Cloud", () => {
    expect(honchoRequiresDeploymentOwner({})).toBe(false);
    expect(honchoRequiresDeploymentOwner({ mode: "cloud" })).toBe(false);
    for (const mode of ["local", " local ", "LOCAL", ""]) {
      expect(honchoRequiresDeploymentOwner({ mode, baseUrl: LOCAL_URL })).toBe(true);
    }
  });

  it.each([" local ", "LOCAL", " cloud "])(
    "rejects the unnormalized mode %j instead of reinterpreting it",
    async (mode) => {
      const fetch = localFetch();
      await expect(
        prepareHonchoConnection(
          { mode, baseUrl: "http://127.0.0.1:8000" },
          { apiKey: "honcho-admin-token" },
          { allowPrivateEndpoint: true, fetch },
        ),
      ).rejects.toThrow(/mode/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("probes a private service name and saves its endpoint", async () => {
    const fetch = localFetch();
    const resolveHostname = vi.fn(privateResolver);
    const prepared = await prepareHonchoConnection(
      { mode: "local", baseUrl: ` ${LOCAL_URL} ` },
      { apiKey: "honcho-admin-token" },
      { allowPrivateEndpoint: true, resolveHostname, fetch },
    );
    expect(prepared).toEqual({
      settings: { mode: "local", baseUrl: LOCAL_URL, reasoningLevel: "low" },
      credentials: { apiKey: "honcho-admin-token" },
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${LOCAL_URL}/v3/workspaces/list?size=1`);
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it.each([
    ["a public hostname", "https://honcho.example.com"],
    ["a public address", "http://203.0.113.10:8000"],
  ])("rejects %s before sending the key", async (_case, baseUrl) => {
    const fetch = localFetch();
    await expect(
      prepareHonchoConnection(
        { mode: "local", baseUrl },
        { apiKey: "honcho-admin-token" },
        { allowPrivateEndpoint: true, resolveHostname: publicResolver, fetch },
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([LOCAL_URL, "http://127.0.0.1:8000", "http://localhost:8000"])(
    "refuses local endpoint %s for anyone but the deployment owner",
    async (baseUrl) => {
      const fetch = localFetch();
      const resolveHostname = vi.fn(privateResolver);
      for (const allowPrivateEndpoint of [false, undefined]) {
        await expect(
          prepareHonchoConnection(
            { mode: "local", baseUrl, workspaceId: "team-notes" },
            { apiKey: "honcho-admin-token" },
            { allowPrivateEndpoint, resolveHostname, fetch },
          ),
        ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);
      }
      expect(resolveHostname).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ mode: "remote", baseUrl: LOCAL_URL }, /mode/],
    [{ mode: "local" }, /baseUrl/],
    [{ mode: "local", baseUrl: `${LOCAL_URL}/?token=1` }, /base URL/],
    [{ mode: "local", baseUrl: "https://api.honcho.dev" }, /Cloud URL/],
    [{ mode: "local", baseUrl: "https://api.honcho.dev/v3/" }, /Cloud URL/],
  ])("rejects invalid local settings %o", (settings, error) => {
    expect(() => createHonchoProvider(settings, { apiKey: "honcho-admin-token" })).toThrow(error);
  });

  it("pins the checked address once and reuses it for every request", async () => {
    const fetch = localFetch();
    const resolveHostname = vi.fn(privateResolver);
    const memory = new HonchoMemoryProvider(
      {
        baseUrl: LOCAL_URL,
        apiKey: "honcho-admin-token",
        reasoningLevel: "low",
        fetch,
        resolveHostname,
      },
      { mode: "local", baseUrl: LOCAL_URL },
    );
    await expect(memory.save(save, context)).resolves.toEqual({ ok: true, value: undefined });
    await memory.save(save, context);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("returns an error instead of calling a host that now resolves publicly", async () => {
    const fetch = localFetch();
    const memory = new HonchoMemoryProvider(
      {
        baseUrl: LOCAL_URL,
        apiKey: "honcho-admin-token",
        reasoningLevel: "low",
        fetch,
        resolveHostname: publicResolver,
      },
      { mode: "local", baseUrl: LOCAL_URL },
    );
    await expect(
      memory.recall({ query: "tone", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toEqual({ ok: false, error: expect.stringMatching(/private-network/) });
    expect(fetch).not.toHaveBeenCalled();
  });
});
