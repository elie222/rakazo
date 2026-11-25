import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "../../approvals/approval-effect.js";
import { buildApprovalContinuation } from "../../runs/lifecycle/run-effects.js";
import type { AcpAgentDescriptor } from "./acp-agent.js";
import { acpAgentRuntime } from "./acp-runtime.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.test-support.mjs", import.meta.url));

const TOOLS: ConnectorTool[] = [
  {
    name: "get_weather",
    description: "Get the weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    readOnly: true,
  },
  {
    name: "send_note",
    description: "Send a note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

type Recorded = { type: string; [key: string]: unknown };

let dir: string;
let recordFile: string;

function descriptor(overrides: Partial<AcpAgentDescriptor> = {}): AcpAgentDescriptor {
  return {
    id: "fake-agent",
    label: "Fake agent",
    command: process.execPath,
    notInstalled: "Fake agent is not installed.",
    async launch({ files, instructions, toolServer, env }) {
      return { args: [FAKE_AGENT, recordFile, files, instructions, toolServer], env };
    },
    toolCallName: (server, tool) => `${server}_${tool}`,
    ...overrides,
  };
}

const fallback: AgentRuntime = {
  describe: () => ({ id: "fallback" }) as never,
  abort: vi.fn(async () => {}),
  async *run() {
    yield { type: "text", text: "from the fallback" };
    yield { type: "done" };
  },
};

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: `thread-${randomUUID()}`,
    runId: randomUUID(),
    prompt: "hello",
    instructions: "You are Pip.",
    history: [],
    tools: TOOLS,
    usageOperationKind: "answer",
    model: { provider: "fake-agent", id: "fake/large" },
    executeTool: vi.fn(async (name: string) =>
      name === "send_note" ? approvalPausedToolResult() : { forecast: "sunny" },
    ),
    ...overrides,
  };
}

async function collect(runtime: AgentRuntime, input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of runtime.run(input, {})) events.push(event);
    return { events, text: textOf(events) };
  } catch (error) {
    return { events, text: textOf(events), error: error as Error };
  }
}

function textOf(events: AgentRuntimeEvent[]) {
  return events.map((event) => (event.type === "text" ? event.text : "")).join("");
}

function recorded(): Recorded[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);
}

function requests(method: string) {
  return recorded().filter((event) => event.type === "request" && event.method === method);
}

function promptText(index = -1) {
  const prompt = requests("session/prompt").at(index)?.params as {
    prompt: Array<{ text?: string }>;
  };
  return prompt.prompt.map((block) => block.text ?? "").join("\n");
}

const allowed = async () => undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rakazo-acp-test-"));
  recordFile = join(dir, "record.jsonl");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("acpAgentRuntime", () => {
  it("runs a Rakazo tool the agent calls and streams its reply", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const input = request({ prompt: "What is the weather?" });

    const { events, text, error } = await collect(runtime, input);

    expect(error).toBeUndefined();
    expect(text).toBe('Checking. It is {"forecast":"sunny"}.');
    expect(input.executeTool).toHaveBeenCalledWith(
      "get_weather",
      { city: "Paris" },
      expect.any(String),
      undefined,
      expect.anything(),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thinking",
      "text",
      "tool",
      "turn",
      "text",
      "usage",
      "done",
    ]);
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      provider: "fake-agent",
      inputTokens: 120,
      outputTokens: 8,
      costUsd: null,
    });
    expect(recorded().find((event) => event.type === "tools")?.names).toEqual([
      "get_weather",
      "send_note",
    ]);
    // The tool endpoint answers only with this turn's token.
    expect(recorded().find((event) => event.type === "unauthenticated")?.status).toBe(401);
  });

  it("gives the agent Rakazo's instructions and only the allowlisted environment", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-fake-openrouter-key");
    vi.stubEnv("DATABASE_URL", "postgres://user:fake-password@db.example.invalid/rakazo");
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    await collect(runtime, request());

    const start = recorded().find((event) => event.type === "start") as unknown as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(start.argv.slice(1)).toEqual(["You are Pip.", "rakazo"]);
    expect(start.env.PATH).toBe(process.env.PATH);
    expect(start.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(start.env.DATABASE_URL).toBeUndefined();
  });

  it("offers the agent no files or terminal of its own", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    await collect(runtime, request());

    expect(requests("initialize")[0]?.params).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  });

  it("selects the deployment model when the agent offers a model choice", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    await collect(runtime, request());

    expect(requests("session/set_config_option")[0]?.params).toMatchObject({
      configId: "model",
      value: "fake/large",
    });
  });

  it("refuses a model the agent does not offer", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { error } = await collect(
      runtime,
      request({ model: { provider: "fake-agent", id: "fake/missing" } }),
    );

    expect(error?.message).toContain('no model "fake/missing"');
    expect(requests("session/prompt")).toHaveLength(0);
  });

  it("starts a new session with the chat so far, and continues it with only what is new", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;
    const history: AgentRunRequest["history"] = [
      { id: "m1", role: "user", content: "Earlier question" },
      { id: "m2", role: "assistant", content: "Earlier answer" },
    ];

    await collect(runtime, request({ threadId, history, sourceMessageId: "m3" }));
    const first = promptText();
    await collect(
      runtime,
      request({
        threadId,
        sourceMessageId: "m6",
        history: [
          ...history,
          { id: "m3", role: "user", content: "hello" },
          { id: "m4", role: "assistant", content: "ok" },
          { id: "m5", role: "user", content: "A teammate's aside", speaker: "Sam" },
        ],
        prompt: "next",
      }),
    );

    expect(first).toContain("[User]: Earlier question");
    expect(first).toContain("[You]: Earlier answer");
    expect(requests("session/new")).toHaveLength(1);
    expect(requests("session/resume")).toHaveLength(1);
    const second = promptText();
    expect(second).toContain("[Sam]: A teammate's aside");
    expect(second).not.toContain("Earlier question");
    expect(second).not.toContain("[User]: hello");
    expect(second.endsWith("next")).toBe(true);
  });

  it("tells the agent when a tool returned an error", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    await collect(
      runtime,
      request({ prompt: "weather", executeTool: vi.fn(async () => ({ error: "No such city" })) }),
    );

    expect(recorded().find((event) => event.type === "tool_result")?.result).toMatchObject({
      isError: true,
    });
  });

  it("gives a second turn running in the same chat a session of its own", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;

    await Promise.all([
      collect(runtime, request({ threadId, prompt: "weather" })),
      collect(runtime, request({ threadId, prompt: "hello" })),
    ]);

    expect(requests("session/new")).toHaveLength(2);
    expect(requests("session/delete")).toHaveLength(1);
    // The chat's own session then learns what the bot replied in the other one.
    await collect(
      runtime,
      request({
        threadId,
        prompt: "next",
        history: [{ id: "m9", role: "assistant", content: "Reply from the other turn" }],
      }),
    );
    expect(promptText()).toContain("[You]: Reply from the other turn");
  });

  it("keeps the newest message when it alone is longer than a new session's history", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const long = `start ${"x".repeat(40_000)} end`;

    await collect(runtime, request({ history: [{ id: "m1", role: "user", content: long }] }));

    expect(promptText()).toContain("x end");
  });

  it("starts over from the chat when the agent no longer has the session", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;
    const history: AgentRunRequest["history"] = [
      { id: "m1", role: "user", content: "Earlier question" },
    ];
    await collect(runtime, request({ threadId, history }));
    rmSync(`${recordFile}.sessions`);

    const { error } = await collect(runtime, request({ threadId, history, prompt: "again" }));

    expect(error).toBeUndefined();
    expect(requests("session/new")).toHaveLength(2);
    expect(promptText()).toContain("[User]: Earlier question");
  });

  it("runs an approved call once on the continuation, with its original arguments", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce(approvalPausedToolResult())
      .mockResolvedValueOnce({ sent: true });

    const paused = await collect(
      runtime,
      request({ threadId, prompt: "Send a note", executeTool }),
    );
    const pausedArgs = executeTool.mock.calls[0]?.[1];
    // The prompt Rakazo builds for a run resumed after the person approved the request.
    const continuation = buildApprovalContinuation(
      [{ kind: "send_note", request: pausedArgs }],
      (args) => JSON.stringify(args),
    )!;
    const resumed = await collect(
      runtime,
      request({ threadId, prompt: continuation, executeTool }),
    );

    expect(paused.events.at(-1)?.type).toBe("done");
    expect(
      recorded().some(
        (event) => event.type === "notification" && event.method === "session/cancel",
      ),
    ).toBe(true);
    expect(requests("session/resume")).toHaveLength(1);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[1]?.[0]).toBe("send_note");
    expect(executeTool.mock.calls[1]?.[1]).toEqual(pausedArgs);
    expect(resumed.error).toBeUndefined();
    expect(resumed.text).toBe('Done: {"sent":true}');
  });

  it("stops a turn in which the agent uses a tool of its own", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;

    const { error } = await collect(runtime, request({ threadId, prompt: "go native" }));
    await collect(runtime, request({ threadId, prompt: "after" }));

    expect(error?.message).toContain("tried to use its own tools (bash)");
    // The session that ran its own tool is not continued.
    expect(requests("session/resume")).toHaveLength(0);
  });

  it("refuses the agent's permission requests and stops the turn", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { error } = await collect(runtime, request({ prompt: "ask permission" }));

    expect(error?.message).toContain("tried to use its own tools (bash)");
  });

  it("runs a helper request in its own session and deletes it", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;
    await collect(runtime, request({ threadId }));

    const { text } = await collect(
      runtime,
      request({ threadId, tools: [], usageOperationKind: "setup", prompt: "a title" }),
    );

    expect(text).toBe("ok");
    expect(requests("session/new")).toHaveLength(2);
    expect(requests("session/new")[1]?.params).toMatchObject({ mcpServers: [] });
    expect(requests("session/delete")).toHaveLength(1);
  });

  it("removes a failed helper's session and keeps the chat's", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const threadId = `thread-${randomUUID()}`;
    await collect(runtime, request({ threadId }));

    const { error } = await collect(
      runtime,
      request({ threadId, tools: [], usageOperationKind: "setup", prompt: "fail" }),
    );
    await collect(runtime, request({ threadId, prompt: "next" }));

    expect(error).toBeDefined();
    expect(requests("session/delete")).toHaveLength(1);
    expect(requests("session/resume")).toHaveLength(1);
  });

  it("moves a turn the agent failed to the person's backup model", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });
    const onModelChange = vi.fn(async () => {});

    const { text, error } = await collect(
      runtime,
      request({
        prompt: "fail",
        fallbackModels: [{ provider: "openrouter", id: "some/backup" }],
        resolveFallbackModel: async (provider, id) => ({ provider, id }),
        onModelChange,
      }),
    );

    expect(error).toBeUndefined();
    expect(text).toBe("from the fallback");
    expect(onModelChange).toHaveBeenCalledWith("openrouter", "some/backup");
  });

  it("answers with the run's fallback text when the agent ends without a reply", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { text } = await collect(
      runtime,
      request({ prompt: "stay silent", emptyResponseText: "Nothing to add." }),
    );

    expect(text).toBe("Nothing to add.");
  });

  it("gives a helper its answer in the done event", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { events } = await collect(
      runtime,
      request({ tools: [], usageOperationKind: "setup", prompt: "check" }),
    );

    expect(events.at(-1)).toEqual({ type: "done", text: "ok" });
  });

  it("reports the agent's error answer", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { error } = await collect(runtime, request({ prompt: "fail" }));

    expect(error?.message).toBe("Fake agent error: Model is overloaded");
  });

  it("sends the descriptor's session settings with every session request", async () => {
    const runtime = acpAgentRuntime(
      fallback,
      descriptor({
        sessionMeta: ({ instructions, toolServer }) => ({ fake: { instructions, toolServer } }),
      }),
      { accessCheck: allowed },
    );
    const threadId = `thread-${randomUUID()}`;

    await collect(runtime, request({ threadId }));
    await collect(runtime, request({ threadId, prompt: "again" }));

    const meta = { fake: { instructions: "You are Pip.", toolServer: "rakazo" } };
    expect(requests("session/new")[0]?.params).toMatchObject({ _meta: meta });
    expect(requests("session/resume")[0]?.params).toMatchObject({ _meta: meta });
  });

  it("says how to sign the agent in when it is signed out", async () => {
    const runtime = acpAgentRuntime(
      fallback,
      descriptor({
        signIn: "Sign in with fake login.",
        sessionMeta: () => ({ fake: { signedOut: true } }),
      }),
      { accessCheck: allowed },
    );

    const { error } = await collect(runtime, request());

    expect(error?.message).toBe(
      "Fake agent API error (401): Fake agent on this server is not signed in. Sign in with fake login.",
    );
  });

  it("refuses to run when the personal CLI gate refuses", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), {
      accessCheck: async () => "Only one account.",
    });

    const { error } = await collect(runtime, request());

    expect(error?.message).toBe("Only one account.");
    expect(recorded()).toHaveLength(0);
  });

  it("says when the agent CLI is not installed", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor({ command: "rakazo-no-such-agent-cli" }), {
      accessCheck: allowed,
    });

    const { error } = await collect(runtime, request());

    expect(error?.message).toBe("Fake agent is not installed.");
  });

  it("leaves every other model to the runtime it wraps", async () => {
    const runtime = acpAgentRuntime(fallback, descriptor(), { accessCheck: allowed });

    const { text } = await collect(
      runtime,
      request({ model: { provider: "openrouter", id: "some/model" } }),
    );

    expect(text).toBe("from the fallback");
    expect(recorded()).toHaveLength(0);
  });
});
