import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import type * as ModelSelection from "./model-selection.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import type * as RunModel from "./run-model.js";
import { resolveModelKey } from "./run-model.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelection>()),
  findConnectedModelCredential: vi.fn(async () => ({ id: "fixture-credential" })),
}));
vi.mock("./run-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunModel>()),
  resolveModelKey: vi.fn(async () => ({
    apiKey: "fixture-model-key",
    projectId: "example-project",
    region: "global",
  })),
}));

it("keeps project routing from the saved checker connection through the runtime request", async () => {
  const run = vi.fn(async function* (request: AgentRunRequest) {
    expect(resolveRuntimeModel(request.model).model?.baseUrl).toBe(
      "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global",
    );
    yield { type: "done", text: '{"decision":"ask","reason":"Requires review."}' };
  });
  const deps = {
    prisma: {},
    secretStore: {},
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run },
  } as unknown as ExecutorDeps;
  const provider = await autoReviewCheckerProvider(
    deps,
    {
      runId: "run-fixture",
      spaceId: "space-fixture",
      userId: "user-fixture",
      botId: "bot-fixture",
      threadId: "thread-fixture",
    },
    { memberChecker: true, registerSecrets: vi.fn() },
    { provider: "google-vertex", model: "gemini-4-hydrogen" },
  );
  const result = await provider.review(
    {
      toolName: "fixture_action",
      connectorKind: "fixture",
      args: {},
      userTask: "Review this action",
      botDescription: "Test bot",
      matchingRules: [],
    },
    {
      operationId: "review-fixture",
      traceId: "review-fixture",
      spaceId: "space-fixture",
      userId: "user-fixture",
      signal: new AbortController().signal,
    },
  );
  expect(result).toMatchObject({ decision: "ask" });
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].model).toMatchObject({
    projectId: "example-project",
    region: "global",
    apiKey: "fixture-model-key",
  });
});

const checkerContext = {
  runId: "run-fixture",
  spaceId: "space-fixture",
  userId: "user-fixture",
  botId: "bot-fixture",
  threadId: "thread-fixture",
};
const checkerDeps = {
  prisma: {},
  secretStore: {},
  runtime: { describe: () => ({ capabilities: { scripted: false } }), run: vi.fn() },
} as unknown as ExecutorDeps;

it("refuses a decision-model checker on a connection that restricts data retention", async () => {
  vi.mocked(resolveModelKey).mockResolvedValueOnce({
    apiKey: "fixture-model-key",
    zeroDataRetention: true,
  } as Awaited<ReturnType<typeof resolveModelKey>>);
  await expect(
    autoReviewCheckerProvider(
      checkerDeps,
      checkerContext,
      { memberChecker: true, registerSecrets: vi.fn() },
      { provider: "openrouter", model: "typesafe/jev-1.14" },
    ),
  ).rejects.toThrow("cannot restrict data retention");
});

it("still builds a decision-model checker when data retention is not restricted", async () => {
  await expect(
    autoReviewCheckerProvider(
      checkerDeps,
      checkerContext,
      { memberChecker: true, registerSecrets: vi.fn() },
      { provider: "openrouter", model: "typesafe/jev-1.14" },
    ),
  ).resolves.toBeDefined();
});

it("passes the data retention choice to a language-model checker", async () => {
  const run = vi.fn(async function* (_request: AgentRunRequest) {
    yield { type: "done", text: '{"decision":"ask","reason":"Requires review."}' };
  });
  vi.mocked(resolveModelKey).mockResolvedValueOnce({
    apiKey: "fixture-model-key",
    zeroDataRetention: true,
  } as Awaited<ReturnType<typeof resolveModelKey>>);
  const provider = await autoReviewCheckerProvider(
    {
      ...checkerDeps,
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run },
    } as unknown as ExecutorDeps,
    checkerContext,
    { memberChecker: true, registerSecrets: vi.fn() },
    { provider: "openrouter", model: "example/model" },
  );
  await provider.review(
    {
      toolName: "fixture_action",
      connectorKind: "fixture",
      args: {},
      userTask: "Review this action",
      botDescription: "Test bot",
      matchingRules: [],
    },
    {
      operationId: "review-fixture",
      traceId: "review-fixture",
      spaceId: "space-fixture",
      userId: "user-fixture",
      signal: new AbortController().signal,
    },
  );
  expect(run.mock.calls[0]?.[0].model).toMatchObject({ zeroDataRetention: true });
});
