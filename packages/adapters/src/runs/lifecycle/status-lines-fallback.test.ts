import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { effectiveModelRole } from "../../models/model-roles.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import type * as RunModel from "../turn/run-model.js";
import { resolveConnectedModelKey } from "../turn/run-model.js";
import { createStatusLineWriter } from "./status-lines.js";

vi.mock("../../models/model-roles.js", () => ({
  effectiveModelRole: vi.fn(async () => ({
    primary: { provider: "anthropic", modelId: "small-a" },
    backups: [{ provider: "openai", modelId: "small-b" }],
    primarySource: "member",
  })),
}));
vi.mock("../turn/run-model.js", async (importOriginal) => ({
  resolvedModelRunFields: (await importOriginal<typeof RunModel>()).resolvedModelRunFields,
  resolveConnectedModelKey: vi.fn(async (...args: unknown[]) => {
    // Resolving a key registers its secret values for redaction, as the real one does.
    (args[4] as (values: string[]) => void)(["sk-resolved-secret"]);
    return { credential: null, resolved: { apiKey: "test-key" } };
  }),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: vi.fn(async () => undefined),
}));

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
    vi.mocked(resolveConnectedModelKey).mockRejectedValueOnce(new Error("database hiccup"));
    const { deps: d, models } = deps(() => "Checking availability");
    const writer = await createStatusLineWriter(d, scope, []);
    const signal = new AbortController().signal;
    await writer?.step("Is it in stock?", "Running: curl …", signal);
    const line = await writer?.step("Is it in stock?", "Running: curl …", signal);
    expect(line).toBe("Checking availability");
    expect(models.filter((model) => model === "small-a").length).toBe(1);
    warn.mockRestore();
  });

  it("starts a new key lookup after one outlasted the time limit", async () => {
    // Each request's time limit, ended by the test instead of the clock.
    const limits: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const limit = new AbortController();
      limits.push(limit);
      return limit.signal;
    });
    try {
      vi.mocked(resolveConnectedModelKey).mockImplementationOnce(() => new Promise(() => {}));
      const { deps: d, models } = deps(() => "Checking availability");
      const writer = await createStatusLineWriter(d, scope, []);
      const signal = new AbortController().signal;
      const first = writer?.step("Is it in stock?", "Running: curl …", signal);
      await vi.waitFor(() => expect(limits).toHaveLength(1));
      limits[0]!.abort(new DOMException("The operation timed out.", "TimeoutError"));
      // The stuck primary is passed over for the fallback.
      expect(await first).toBe("Checking availability");
      expect(models).toEqual(["small-b"]);
      // The next status asks the primary again instead of waiting on the stuck lookup.
      expect(await writer?.step("Is it in stock?", "Running: curl …", signal)).toBe(
        "Checking availability",
      );
      expect(models).toEqual(["small-b", "small-a"]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("resolves each status model's key with the checks every role model gets", async () => {
    const { deps: d } = deps(() => "Checking availability");
    const writer = await createStatusLineWriter(d, scope, []);
    await writer?.step("Is it in stock?", "Running: curl …", new AbortController().signal);
    // A stored secret is required, so a pinned connection that is gone fails over to the
    // next model instead of running on the deployment's key.
    expect(resolveConnectedModelKey).toHaveBeenCalledWith(
      d,
      { userId: "user-1", spaceId: "space-1" },
      "anthropic",
      "small-a",
      expect.any(Function),
      true,
      undefined,
    );
  });

  it("sends the status model every field its connection carries", async () => {
    const requests: AgentRunRequest[] = [];
    vi.mocked(resolveConnectedModelKey).mockResolvedValueOnce({
      credential: null,
      resolved: {
        apiKey: "test-key",
        zeroDataRetention: true,
        projectId: "project-1",
        region: "us-east5",
        apiProtocol: "chat-completions",
      },
    } as never);
    const { deps: d } = deps(() => "Checking availability");
    const run = d.runtime.run;
    d.runtime.run = (request, context) => {
      requests.push(request);
      return run(request, context);
    };
    const writer = await createStatusLineWriter(d, scope, []);
    await writer?.step("Is it in stock?", "Running: curl …", new AbortController().signal);
    expect(requests[0]?.model).toMatchObject({
      zeroDataRetention: true,
      projectId: "project-1",
      region: "us-east5",
      apiProtocol: "chat-completions",
      thinkingLevel: "off",
    });
  });
});
