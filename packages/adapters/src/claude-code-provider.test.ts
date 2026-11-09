import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { normalizeRunError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_BILLING_REFUSAL,
  CLAUDE_CODE_SHARED_REFUSAL,
  claudeCodeAccessCheck,
} from "./claude-code-access.js";
import {
  CLAUDE_CODE_NOT_INSTALLED_ERROR,
  CLAUDE_CODE_SIGNED_OUT_ERROR,
} from "./claude-code-cli.js";
import {
  CLAUDE_CODE_PROVIDER_ID,
  claudeCodeProvider,
  registerClaudeCodeProvider,
  setClaudeCodeAccessCheck,
} from "./claude-code-provider.js";
import { hostCredentialSource, resolveDeploymentModel } from "./deployment-model.js";
import { listPiCatalog } from "./pi-models.js";
import { normalizePiUsage } from "./pi-usage.js";

const FAKE_CLI = fileURLToPath(new URL("./claude-code-fake-cli.test-support.mjs", import.meta.url));
const MODEL_ID = "claude-sonnet-5";

// Server secrets that must never reach the CLI. Fake values, checked for below.
const SERVER_SECRETS = {
  ANTHROPIC_API_KEY: "sk-fake-anthropic-key",
  ANTHROPIC_AUTH_TOKEN: "fake-anthropic-token",
  ANTHROPIC_BASE_URL: "https://relay.example.invalid",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
  OPENROUTER_API_KEY: "sk-fake-openrouter-key",
  DATABASE_URL: "postgres://user:fake-password@db.example.invalid/rakazo",
};

const tools = [
  {
    name: "lookup",
    description: "Look up the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];
const hello: Context = {
  systemPrompt: "You are a helpful bot.",
  messages: [{ role: "user", content: "Hi", timestamp: 1 }],
  tools,
};

let models: MutableModels;
let model: Model<Api>;

/** Puts a fake `claude` first on PATH; it records what it was started with. */
function fakeClaude(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "rakazo-fake-claude-"));
  const record = join(dir, "record.json");
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "${scenario}" "${record}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
  return {
    started: () => existsSync(record),
    read: () =>
      JSON.parse(readFileSync(record, "utf8")) as {
        args: string[];
        env: Record<string, string>;
        cwd: string;
        system: string;
        frames: unknown[];
        tools: { init?: { protocolVersion?: string }; tools: unknown[]; call?: unknown };
      },
    /** Whether the fake was still running well after the reply ended. */
    survived: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return existsSync(`${record}.survived`);
    },
  };
}

async function run(
  context: Context,
  options: { signal?: AbortSignal; onEvent?: (event: AssistantMessageEvent) => void } = {},
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const stream = models.streamSimple(model, context, { signal: options.signal, reasoning: "high" });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    options.onEvent?.(event);
  }
  return { events, message: await stream.result() };
}

describe.skipIf(process.platform === "win32")("Claude Code CLI provider", () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("PI_DEFAULT_PROVIDER", CLAUDE_CODE_PROVIDER_ID);
    vi.stubEnv("PI_DEFAULT_MODEL", MODEL_ID);
    vi.stubEnv("PI_DEFAULT_CREDENTIALS", "host");
    models = registerClaudeCodeProvider(builtinModels());
    model = models.getModel(CLAUDE_CODE_PROVIDER_ID, MODEL_ID)!;
  });
  beforeEach(() => {
    setClaudeCodeAccessCheck(async () => undefined);
  });
  afterAll(() => {
    setClaudeCodeAccessCheck(undefined);
    vi.unstubAllEnvs();
  });

  it("describes the model with Anthropic's limits and no price", () => {
    const card = models.getModel("anthropic", MODEL_ID)!;
    expect(model).toMatchObject({
      provider: CLAUDE_CODE_PROVIDER_ID,
      contextWindow: card.contextWindow,
      maxTokens: card.maxTokens,
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("streams a reply from the signed-in CLI", async () => {
    const cli = fakeClaude("reply");
    const { events, message } = await run(hello);

    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Let me think.", thinkingSignature: "sig-1" },
      { type: "text", text: "Hello there" },
    ]);
    expect(message.responseId).toBe("msg_1");
    expect(message.usage).toMatchObject({
      input: 12,
      cacheRead: 3,
      cacheWrite: 4,
      output: 7,
      totalTokens: 26,
      cost: { total: 0 },
    });
    // The plan pays, so the run records an unknown cost rather than a free one.
    expect(normalizePiUsage(message.usage, model).costUsd).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    const record = cli.read();
    expect(record.system).toBe("You are a helpful bot.");
    expect(record.frames).toEqual([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
    ]);
    // The inventory server lists Rakazo's tools and never runs one.
    expect(record.tools.init?.protocolVersion).toBe("2025-06-18");
    expect(record.tools.tools).toEqual([
      { name: "lookup", description: tools[0]!.description, inputSchema: tools[0]!.parameters },
    ]);
    expect(record.tools.call).toMatchObject({ isError: true });
  });

  it("starts the unmodified CLI with its own tools, settings and sessions off", async () => {
    const cli = fakeClaude("reply");
    await run(hello);
    const { args, cwd } = cli.read();
    const value = (flag: string) => args[args.indexOf(flag) + 1];

    expect(args.slice(0, 5)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
    expect(value("--model")).toBe(MODEL_ID);
    expect(value("--tools")).toBe("");
    expect(value("--setting-sources")).toBe("");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--max-turns")).toBe("1");
    expect(value("--effort")).toBe("high");
    expect(value("--session-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
      ]),
    );
    for (const flag of [
      "--dangerously-skip-permissions",
      "--allowedTools",
      "--allowed-tools",
      "--settings",
      "--resume",
      "--continue",
      "--append-system-prompt",
    ]) {
      expect(args).not.toContain(flag);
    }
    // An empty private directory, so the CLI finds no project files.
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("keeps API keys, tokens and other server secrets out of the CLI's environment", async () => {
    const cli = fakeClaude("reply");
    await run(hello);
    const { env } = cli.read();

    for (const name of Object.keys(SERVER_SECRETS)) expect(env).not.toHaveProperty(name);
    const values = Object.values(env).join("\n");
    for (const secret of Object.values(SERVER_SECRETS)) expect(values).not.toContain(secret);
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env.HOME).toBe(process.env.HOME);
    expect(env).toMatchObject({
      DISABLE_AUTOUPDATER: "1",
      DISABLE_AUTO_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.maxTokens),
    });
  });

  it("hands a tool call back to Rakazo and stops the CLI before it goes on", async () => {
    const cli = fakeClaude("tool");
    const { events, message } = await run(hello);

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "toolCall", id: "toolu_1", name: "lookup", arguments: { city: "Taipei" } },
    ]);
    expect(events.at(-1)?.type).toBe("done");
    expect(await cli.survived()).toBe(false);
  });

  it("replays earlier turns as history the CLI does not answer", async () => {
    const cli = fakeClaude("reply");
    const previous: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Checking.", thinkingSignature: "sig-0" },
        { type: "toolCall", id: "toolu_0", name: "lookup", arguments: { city: "Paris" } },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    };
    await run({
      ...hello,
      messages: [
        { role: "user", content: "Weather in Paris?", timestamp: 1 },
        previous,
        {
          role: "toolResult",
          toolCallId: "toolu_0",
          toolName: "lookup",
          content: [{ type: "text", text: "Sunny" }],
          isError: false,
          timestamp: 3,
        },
        { role: "user", content: "Thanks", timestamp: 4 },
      ],
    });

    expect(cli.read().frames).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
        shouldQuery: false,
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking.", signature: "sig-0" },
            {
              type: "tool_use",
              id: "toolu_0",
              name: "mcp__rakazo__lookup",
              input: { city: "Paris" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_0",
              content: [{ type: "text", text: "Sunny" }],
            },
            { type: "text", text: "Thanks" },
          ],
        },
      },
    ]);
  });

  it("fails clearly when the CLI cannot replay history", async () => {
    fakeClaude("no-replay");
    const { message } = await run({
      ...hello,
      messages: [
        { role: "user", content: "First", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Noted." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "Second", timestamp: 3 },
      ],
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/cannot load conversation history/);
  });

  it("asks the operator to sign in instead of starting a signed-out CLI", async () => {
    const cli = fakeClaude("signed-out");
    const { events, message } = await run(hello);

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(message.errorMessage).toBe(CLAUDE_CODE_SIGNED_OUT_ERROR);
    expect(normalizeRunError(message.errorMessage!)).toMatchObject({ kind: "auth" });
    expect(cli.started()).toBe(false);
  });

  it.each([
    ["rate-limit", 429, "rate"],
    ["usage-limit", 429, "rate"],
    ["billing", 402, "credit"],
  ])("reports the CLI's %s error with its status", async (scenario, status, kind) => {
    fakeClaude(scenario);
    const { message } = await run(hello);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(new RegExp(`^Claude Code API error \\(${status}\\): `));
    expect(normalizeRunError(message.errorMessage!)).toMatchObject({ status, kind });
  });

  it("treats a rejected sign-in during a request as signed out", async () => {
    fakeClaude("rejected-login");
    const { message } = await run(hello);
    expect(message.errorMessage).toBe(CLAUDE_CODE_SIGNED_OUT_ERROR);
  });

  it("stops the CLI when the run is interrupted", async () => {
    const cli = fakeClaude("hang");
    const controller = new AbortController();
    const { message } = await run(hello, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta") controller.abort();
      },
    });

    expect(message.stopReason).toBe("aborted");
    expect(await cli.survived()).toBe(false);
  });

  it.each([
    ["not-json", /not stream-json: Welcome to Claude Code!/],
    ["crash", /exit code 3/],
    ["old-version", /older than \d+\.\d+\.\d+\. Run `claude update`/],
    ["built-in-tools", /its own tools enabled: Bash, Read/],
    ["no-tool-server", /could not load Rakazo's tools/],
  ])("fails clearly on %s", async (scenario, error) => {
    fakeClaude(scenario);
    const { message } = await run(hello);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(error);
  });

  it("gives up on a CLI that stops reading its input", async () => {
    fakeClaude("deaf");
    const long: Context = {
      systemPrompt: "You are a helpful bot.",
      messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024), timestamp: 1 }],
    };
    const message = await models.streamSimple(model, long, { timeoutMs: 500 }).result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/stopped responding/);
  });

  it("redacts secrets from the CLI's error output", async () => {
    fakeClaude("crash");
    const { message } = await run(hello);
    expect(message.errorMessage).toContain("[redacted]");
    expect(message.errorMessage).not.toContain("sk-fake-123");
  });

  it("says when the CLI is not installed", async () => {
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "rakazo-no-claude-")));
    const { message } = await run(hello);
    expect(message.errorMessage).toBe(CLAUDE_CODE_NOT_INSTALLED_ERROR);
  });

  it("refuses every request until the run runtime allows it", async () => {
    const cli = fakeClaude("reply");
    setClaudeCodeAccessCheck(undefined);
    expect((await run(hello)).message.errorMessage).toMatch(
      /only inside the Rakazo API and worker/,
    );
    setClaudeCodeAccessCheck(async () => CLAUDE_CODE_SHARED_REFUSAL);
    expect((await run(hello)).message.errorMessage).toBe(CLAUDE_CODE_SHARED_REFUSAL);
    expect(cli.started()).toBe(false);
  });
});

describe("Claude Code deployment", () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  const env = {
    PI_DEFAULT_PROVIDER: CLAUDE_CODE_PROVIDER_ID,
    PI_DEFAULT_MODEL: MODEL_ID,
    PI_DEFAULT_CREDENTIALS: "host",
  };

  it("runs the deployment model on the host's own sign-in only when asked to", () => {
    expect(resolveDeploymentModel(env)).toEqual({
      provider: CLAUDE_CODE_PROVIDER_ID,
      model: MODEL_ID,
      key: undefined,
      configured: true,
      hostCredentials: true,
    });
    expect(resolveDeploymentModel({ ...env, PI_DEFAULT_CREDENTIALS: undefined }).configured).toBe(
      false,
    );
    expect(hostCredentialSource(CLAUDE_CODE_PROVIDER_ID)).toBe("Claude Code");
  });

  it("registers the provider only for that deployment model", () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(
      claudeCodeProvider(builtinModels())
        ?.getModels()
        .map((card) => card.id),
    ).toEqual([MODEL_ID]);
    vi.stubEnv("PI_DEFAULT_CREDENTIALS", "");
    expect(claudeCodeProvider(builtinModels())).toBeUndefined();
  });

  it("is never offered in the model catalog", () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(listPiCatalog().some((entry) => entry.provider === CLAUDE_CODE_PROVIDER_ID)).toBe(false);
  });
});

describe("claudeCodeAccessCheck", () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  function prisma(people: number, modelCreditsEnabled = false) {
    const count = vi.fn(async () => people);
    return {
      count,
      client: {
        user: { count },
        deploymentSettings: { findUnique: async () => ({ modelCreditsEnabled }) },
      } as unknown as PrismaClient,
    };
  }

  it("allows a single-account server and counts only people with accounts", async () => {
    const db = prisma(1);
    expect(await claudeCodeAccessCheck({ prisma: db.client })()).toBeUndefined();
    expect(db.count).toHaveBeenCalledWith({
      where: { deactivatedAt: null, NOT: { email: { endsWith: "@messaging.invalid" } } },
    });
  });

  it("refuses a server shared by more than one account", async () => {
    expect(await claudeCodeAccessCheck({ prisma: prisma(2).client })()).toBe(
      CLAUDE_CODE_SHARED_REFUSAL,
    );
  });

  it("refuses at once when a second account appears", async () => {
    const db = prisma(1);
    const check = claudeCodeAccessCheck({ prisma: db.client });
    expect(await check()).toBeUndefined();
    db.count.mockResolvedValue(2);
    expect(await check()).toBe(CLAUDE_CODE_SHARED_REFUSAL);
  });

  it("refuses a server that sells model usage", async () => {
    expect(await claudeCodeAccessCheck({ prisma: prisma(1, true).client })()).toBe(
      CLAUDE_CODE_BILLING_REFUSAL,
    );
    expect(await claudeCodeAccessCheck({ prisma: prisma(1).client, billingEnabled: true })()).toBe(
      CLAUDE_CODE_BILLING_REFUSAL,
    );
  });
});

describe("Claude Code bridge sources", () => {
  it("never read, copy or forward the CLI's sign-in", () => {
    const sources = [
      "claude-code-provider-id.ts",
      "claude-code-provider.ts",
      "claude-code-access.ts",
      "claude-code-cli.ts",
      "claude-code-stream.ts",
    ].map((file) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8"));
    for (const source of sources) {
      expect(source).not.toMatch(
        /\.credentials\.json|keychain|find-generic-password|setup-token|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)|sk-ant-|homedir\(|["'`~/]\.claude\b/i,
      );
    }
  });
});
