import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMobileThreadEvent,
  blockText,
  type MobileMessage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  prependMobileMessagePage,
  rpc,
  shouldApplyMobileThreadRefresh,
  signIn,
  signOut,
  subscribeThread,
} from "./api.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile API authentication", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
  });

  it("persists a successful sign-in token and sends the native origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "session-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await signIn("ada@example.com", "correct horse");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-in/email",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ email: "ada@example.com", password: "correct horse" }),
      }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "session-token");
  });

  it("surfaces the server message and does not persist a failed sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Invalid credentials" }, { status: 401 })),
    );

    await expect(signIn("ada@example.com", "wrong")).rejects.toThrow("Invalid credentials");
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("clears the local session even when the sign-out request fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    await expect(signOut()).resolves.toBeUndefined();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("sends authenticated RPC input and reports structured RPC errors", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: { ok: true } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Bot does not exist" } }, { status: 404 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc<{ ok: boolean }>("bots/get", { botId: "bot-1" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/rpc/bots/get",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
    );
    await expect(rpc("bots/get", { botId: "missing" })).rejects.toThrow("Bot does not exist");
  });
});

describe("mobile thread subscription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("");
  });

  it("parses fragmented SSE frames and ignores malformed data and completion markers", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.pro'));
        controller.enqueue(
          encoder.encode(
            'gress","seq":4,"payload":{"delta":"Hi"}}}\n\ndata: not-json\n\ndata: [DONE]\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.message.created",\n' +
              'data: "seq":5,"payload":{"messageId":"m1"}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, 3, onEvent, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/rpc/threads/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/event-stream" }),
        body: JSON.stringify({ json: { botId: "bot-1", cursor: 3 } }),
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "thread.progress", seq: 4 }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "thread.message.created", seq: 5 }),
    );
  });

  it("rejects responses that are unsuccessful or have no stream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (200)");
  });
});

describe("mobile thread refresh targeting", () => {
  it("drops a deferred group A refresh after navigation to group B", async () => {
    let activeGroupId: string | undefined = "group-a";
    let currentEpoch = 1;
    let resolveRequest!: (snapshot: MobileSnapshot) => void;
    const request = new Promise<MobileSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    let applied: MobileSnapshot | null = null;
    const refresh = request.then((snapshot) => {
      if (
        shouldApplyMobileThreadRefresh({
          requestEpoch: 1,
          currentEpoch,
          targetBotId: undefined,
          targetGroupId: "group-a",
          activeBotId: undefined,
          activeGroupId,
        })
      ) {
        applied = snapshot;
      }
    });

    activeGroupId = "group-b";
    currentEpoch += 1;
    resolveRequest({
      groupId: "group-a",
      threadId: "thread-a",
      messages: [],
      olderCursor: null,
      run: null,
    });
    await refresh;

    expect(applied).toBeNull();
  });
});

describe("mobile thread event reduction", () => {
  it("prepends ordered history pages without duplicating the boundary message", () => {
    const initial = snapshot([mobileMessage("m-2", [], 2), mobileMessage("m-3", [], 3)], 2);

    const next = prependMobileMessagePage(initial, {
      threadId: "thread-1",
      messages: [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("m-2", [], 2),
      ],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("retains loaded history across refresh while dropping stale progress", () => {
    const initial = snapshot(
      [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }], 8),
      ],
      null,
    );
    const refreshed = snapshot([mobileMessage("m-1", [], 1), mobileMessage("m-2", [], 2)], 1);

    const next = mergeMobileSnapshot(initial, refreshed, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("accumulates progress deltas for the same run", () => {
    const first = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "Hel" },
    });
    const second = applyMobileThreadEvent(first, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "lo" },
    });

    expect(second?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      },
    ]);
  });

  it("preserves progress from a legacy run-only snapshot", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-legacy", [{ kind: "progress", text: "Still working" }]),
          runId: "run-legacy",
        },
      ]),
      run: { id: "run-legacy", status: "running" },
      activeRuns: undefined,
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-new",
      payload: { text: "New work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress when active-run metadata lags", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-concurrent", [
            { kind: "progress", text: "Concurrent work" },
          ]),
          runId: "run-concurrent",
        },
      ]),
      run: { id: "run-current", status: "running" },
      activeRuns: [{ id: "run-current", status: "running" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-current",
      payload: { text: "Current work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-concurrent",
      "progress:run-current",
    ]);
  });

  it("holds live tool steps until mobile narration reaches a sentence boundary", () => {
    const narration = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { text: "Let me check " },
    });
    const pending = applyMobileThreadEvent(narration, {
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });
    const completed = applyMobileThreadEvent(pending, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "now." },
    });

    expect(pending?.messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check ",
        pendingToolNames: ["SLACK_FIND_CHANNELS"],
      },
    ]);
    expect(completed?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
    expect(blockText(completed?.messages[0] as MobileMessage)).toBe(
      "Let me check now.\nSlack find channels",
    );
  });

  it("deduplicates durable messages and replaces matching transient subagent state", () => {
    const initial = snapshot([
      mobileMessage("message-1", [{ kind: "text", text: "old" }]),
      mobileMessage("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Search",
          status: "running",
        },
      ]),
      mobileMessage("subagent:other", [
        { kind: "subagent", agentId: "other", name: "Other", task: "Wait", status: "running" },
      ]),
      {
        ...mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }]),
        runId: "run-1",
      },
    ]);
    const completed = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Search",
      status: "completed" as const,
      result: "Done",
    };

    const next = applyMobileThreadEvent(initial, {
      id: "event-1",
      type: "thread.message.created",
      seq: 9,
      runId: "run-1",
      payload: { messageId: "message-1", role: "bot", blocks: [completed] },
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:other", "message-1"]);
    expect(next?.messages[1]?.blocks).toEqual([completed]);
  });

  it("clears loaded history and active state when another client clears the thread", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "old" }])], 1);
    initial.run = { id: "run-1", status: "running" };

    const next = applyMobileThreadEvent(initial, { type: "thread.cleared", seq: 12 });

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("applies the durable waiting-input run transition", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: { id: "run-1", status: "running" } };
    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 8,
    });

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(8);
    const repeated = applyMobileThreadEvent(waiting, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 9,
    });
    expect(repeated?.cursor).toBe(9);
    expect(repeated?.run).toBe(waiting?.run);
  });

  it("advances the cursor for durable message events", () => {
    const next = applyMobileThreadEvent(snapshot(), {
      type: "thread.message.created",
      seq: 11,
      payload: { messageId: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
    });

    expect(next?.cursor).toBe(11);
  });

  it("preserves ask actions and runId on created messages", () => {
    const initial = snapshot();
    const askBlock = {
      kind: "ask",
      text: "Review before writing",
      detail: "title: Result",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      runId: "run-1",
      payload: { messageId: "message-ask", role: "bot", blocks: [askBlock] },
    });

    expect(next?.messages.at(-1)).toMatchObject({
      id: "message-ask",
      runId: "run-1",
      blocks: [askBlock],
    });
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-newer", status: "running" },
      activeRuns: [
        { id: "run-newer", status: "running" },
        { id: "run-waiting", status: "running" },
      ],
    };

    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-waiting",
    });

    expect(waiting?.run).toEqual({ id: "run-newer", status: "running" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-newer", status: "running" },
      { id: "run-waiting", status: "waiting_input" },
    ]);
  });

  it("clears only the terminal run's live progress", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.cancelled",
      seq: 10,
      runId: runA.id,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps a failed member run's error while another member run is still active", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.failed",
      seq: 11,
      runId: runB.id,
      payload: { error: "member exploded" },
    });

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toEqual({ id: runB.id, status: "failed", error: "member exploded" });
    expect(next?.messages).toEqual([]);
  });

  it("leaves the snapshot unchanged for unrelated events", () => {
    const initial = snapshot();
    expect(applyMobileThreadEvent(initial, { type: "run.started" })).toBe(initial);
    expect(applyMobileThreadEvent(null, { type: "thread.progress" })).toBeNull();
  });
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function snapshot(
  messages: MobileMessage[] = [],
  olderCursor: number | null = null,
): MobileSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: {
      state: "running",
      controlHolder: "bot",
      screenAvailable: true,
      mode: "team",
      busyBotName: null,
    },
  };
}

function mobileMessage(id: string, blocks: MobileMessage["blocks"], seq?: number): MobileMessage {
  return { id, threadId: "thread-1", seq, role: "bot", blocks };
}
