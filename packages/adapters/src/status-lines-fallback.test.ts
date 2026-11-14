import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { effectiveModelRole } from "./model-roles.js";
import { resolveModelKey } from "./run-model.js";
import { createStatusLineWriter } from "./status-lines.js";

vi.mock("./model-roles.js", () => ({
  effectiveModelRole: vi.fn(async () => ({
    primary: { provider: "anthropic", modelId: "small-a" },
    backups: [{ provider: "openai", modelId: "small-b" }],
    primarySource: "member",
  })),
}));
vi.mock("./model-selection.js", () => ({
  findConnectedModelCredential: vi.fn(async () => null),
}));
vi.mock("./run-model.js", () => ({
  resolveModelKey: vi.fn(async (...args: unknown[]) => {
    // Resolving a key registers its secret values for redaction, as the real one does.
    (args[6] as (values: string[]) => void)(["sk-resolved-secret"]);
    return { apiKey: "test-key" };
  }),
}));
vi.mock("@rakazo/db", () => ({ recordUsage: vi.fn(async () => undefined) }));

const scope = {
  runId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "t-1",
};

function deps(reply: (model: string) => string | Error) {
  const models: string[] = [];
  const prompts: string[] = [];
  const runtime = {
    run: async function* (request: AgentRunRequest): AsyncGenerator<AgentRuntimeEvent> {
      models.push(request.model.id);
      prompts.push(request.prompt);
      const answer = reply(request.model.id);
      if (answer instanceof Error) throw answer;
      yield { type: "done", text: answer } as AgentRuntimeEvent;
    },
  };
  return {
    deps: { prisma: {}, secretStore: {}, runtime } as unknown as ExecutorDeps,
    models,
    prompts,
  };
}

describe("createStatusLineWriter", () => {
  it("asks the fallback when the primary status model fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps: d, models } = deps((model) =>
      model === "small-a" ? new Error("overloaded") : "Checking availability",
    );
    const writer = await createStatusLineWriter(d, scope, []);
    const line = await writer?.step(
      "Is it in stock?",
      "Running: curl …",
      new AbortController().signal,
    );
    expect(line).toBe("Checking availability");
    expect(models).toEqual(["small-a", "small-b"]);
    warn.mockRestore();
  });

  it("asks the fallback when the primary answers with nothing usable", async () => {
    const { deps: d, models } = deps((model) =>
      model === "small-a" ? "<request>oops</request>" : "Checking availability",
    );
    const writer = await createStatusLineWriter(d, scope, []);
    const line = await writer?.step(
      "Is it in stock?",
      "Running: curl …",
      new AbortController().signal,
    );
    expect(line).toBe("Checking availability");
    expect(models).toEqual(["small-a", "small-b"]);
  });

  it("redacts a credential the status model's key resolution registers", async () => {
    const { deps: d, prompts } = deps(() => "Checking availability");
    const writer = await createStatusLineWriter(d, scope, []);
    await writer?.step(
      "Use sk-resolved-secret to check",
      "Running: curl …",
      new AbortController().signal,
    );
    expect(prompts[0]).not.toContain("sk-resolved-secret");
  });

  it("treats a failure reported in the final text as no answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps: d, models } = deps((model) =>
      model === "small-a" ? "Unknown model small-a" : "Checking availability",
    );
    const writer = await createStatusLineWriter(d, scope, []);
    const line = await writer?.step(
      "Is it in stock?",
      "Running: curl …",
      new AbortController().signal,
    );
    expect(line).toBe("Checking availability");
    expect(models).toEqual(["small-a", "small-b"]);
    warn.mockRestore();
  });

  it("stops at the first model that writes a status", async () => {
    const { deps: d, models } = deps(() => "Reading your question\nLooking up prices");
    const writer = await createStatusLineWriter(d, scope, []);
    const line = await writer?.opening("How much is the plan?", new AbortController().signal);
    expect(line).toBe("Reading your question");
    expect(models).toEqual(["small-a"]);
  });

  it("uses a member's fallbacks when no primary is set", async () => {
    vi.mocked(effectiveModelRole).mockResolvedValueOnce({
      primary: null,
      backups: [{ provider: "openai", modelId: "small-b" }],
      primarySource: "member",
    } as unknown as Awaited<ReturnType<typeof effectiveModelRole>>);
    const { deps: d, models } = deps(() => "Checking availability");
    const writer = await createStatusLineWriter(d, scope, []);
    const line = await writer?.step(
      "Is it in stock?",
      "Running: curl …",
      new AbortController().signal,
    );
    expect(line).toBe("Checking availability");
    expect(models).toEqual(["small-b"]);
  });

  it("tries a model's key again after a failed lookup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(resolveModelKey).mockRejectedValueOnce(new Error("database hiccup"));
    const { deps: d, models } = deps(() => "Checking availability");
    const writer = await createStatusLineWriter(d, scope, []);
    const signal = new AbortController().signal;
    await writer?.step("Is it in stock?", "Running: curl …", signal);
    const line = await writer?.step("Is it in stock?", "Running: curl …", signal);
    expect(line).toBe("Checking availability");
    expect(models.filter((model) => model === "small-a").length).toBe(1);
    warn.mockRestore();
  });
});
