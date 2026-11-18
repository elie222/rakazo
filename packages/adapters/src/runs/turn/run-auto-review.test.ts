import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import type * as ModelSelection from "../../models/model-selection.js";
import { findConnectedModelCredential } from "../../models/model-selection.js";
import { resolveRuntimeModel } from "../../runtime/pi/pi-runtime-models.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import type * as RunModel from "./run-model.js";
import { resolveModelKey } from "./run-model.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

vi.mock("../../models/model-selection.js", async (importOriginal) => ({
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

it.each([false, true])(
  "keeps an included decision checker operator-funded with a personal connection (pinned=%s)",
  async (pinned) => {
    vi.stubEnv("OPENROUTER_API_KEY", "fake-operator-key");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", pinned ? "openrouter" : "");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", pinned ? "typesafe/jev-1.14" : "");
    vi.mocked(findConnectedModelCredential).mockClear();
    vi.mocked(resolveModelKey).mockClear();
    const deps = {
      billingEnabled: true,
      prisma: {
        space: { findUnique: async () => ({ organizationId: "organization-fixture" }) },
        member: { findUnique: async () => ({ role: "owner" }) },
        billingAccount: { findUnique: async () => ({ status: "active", paidAt: new Date(0) }) },
      },
      secretStore: {},
    } as unknown as ExecutorDeps;
    // A matching member backup must not change the primary's funding source.
    const options = {
      memberChecker: false,
      registerSecrets: vi.fn(),
      backups: [{ provider: "openrouter", modelId: "typesafe/jev-1.14" }],
    };
    await autoReviewCheckerProvider(
      deps,
      {
        runId: "run-fixture",
        spaceId: "space-fixture",
        userId: "user-fixture",
        botId: "bot-fixture",
        threadId: "thread-fixture",
      },
      options,
      { provider: "openrouter", model: "typesafe/jev-1.14" },
    );
    expect(findConnectedModelCredential).not.toHaveBeenCalled();
    expect(resolveModelKey).not.toHaveBeenCalled();
    expect(options.registerSecrets).toHaveBeenCalledWith(["fake-operator-key"]);
  },
);

it("preserves personal authentication for a legacy hosted deployment checker", async () => {
  vi.mocked(findConnectedModelCredential).mockClear();
  const deps = { billingEnabled: true, prisma: {}, secretStore: {} } as unknown as ExecutorDeps;
  await autoReviewCheckerProvider(
    deps,
    { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
    { memberChecker: false, registerSecrets: vi.fn() },
    { provider: "google-vertex", model: "gemini-4-hydrogen" },
  );
  expect(findConnectedModelCredential).toHaveBeenCalledOnce();
  expect(resolveModelKey).toHaveBeenLastCalledWith(
    deps,
    "user",
    "space",
    expect.objectContaining({ id: "fixture-credential" }),
    "google-vertex",
    "gemini-4-hydrogen",
    expect.any(Function),
    expect.objectContaining({ operatorFunded: false }),
  );
});

it("keeps a personal decision connection when hosted auth is unavailable", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.mocked(findConnectedModelCredential).mockClear();
  const deps = { billingEnabled: true, prisma: {}, secretStore: {} } as unknown as ExecutorDeps;
  await autoReviewCheckerProvider(
    deps,
    { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
    { memberChecker: false, registerSecrets: vi.fn() },
    { provider: "openrouter", model: "typesafe/jev-1.14" },
  );
  expect(findConnectedModelCredential).toHaveBeenCalledOnce();
  expect(resolveModelKey).toHaveBeenLastCalledWith(
    deps,
    "user",
    "space",
    expect.objectContaining({ id: "fixture-credential" }),
    "openrouter",
    "typesafe/jev-1.14",
    expect.any(Function),
    expect.objectContaining({ operatorFunded: false }),
  );
});

it("keeps an explicitly credit-funded checker separate from the included checker", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "fake-operator-key");
  vi.mocked(findConnectedModelCredential).mockClear();
  const deps = { billingEnabled: true, prisma: {}, secretStore: {} } as unknown as ExecutorDeps;
  await autoReviewCheckerProvider(
    deps,
    { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
    { memberChecker: false, registerSecrets: vi.fn() },
    { provider: "openrouter", model: "typesafe/jev-1.14", creditOfferingId: "member-offering" },
  );
  expect(findConnectedModelCredential).not.toHaveBeenCalled();
  expect(resolveModelKey).toHaveBeenLastCalledWith(
    deps,
    "user",
    "space",
    null,
    "openrouter",
    "typesafe/jev-1.14",
    expect.any(Function),
    expect.objectContaining({ operatorFunded: false, creditOfferingId: "member-offering" }),
  );
});

it("retains direct self-hosted checker usage in the customer usage view", async () => {
  vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "jev");
  vi.stubEnv("TYPESAFE_API_KEY", "fake-direct-checker-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        answers: { decision: { type: "choice", choice: "pass", confidence: 0.99 } },
        usage: { input_tokens: 100, output_tokens: 0, cost: 0.0001 },
      }),
    ),
  );
  const createMany = vi.fn();
  const tx = { usageRecord: { createMany }, modelCreditEntry: { findUnique: async () => null } };
  const deps = {
    billingEnabled: false,
    prisma: { $transaction: async (work: (value: unknown) => unknown) => work(tx) },
  } as unknown as ExecutorDeps;
  const scope = {
    runId: "run",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    threadId: "thread",
  };
  const checker = await autoReviewCheckerProvider(
    deps,
    scope,
    { memberChecker: false, registerSecrets: vi.fn() },
    { provider: "jev", model: "jev-latest" },
  );
  await checker.review(
    {
      toolName: "test_action",
      connectorKind: "test",
      args: {},
      userTask: "Synthetic task",
      botDescription: "Test bot",
      matchingRules: [],
    },
    {
      operationId: "review",
      traceId: "review",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  );
  expect(createMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: [
        expect.objectContaining({
          fundingSource: "customer",
          provider: "typesafe",
          costUsd: 0.0001,
        }),
      ],
    }),
  );
});

it.each([
  ["typesafe", "jev-1.14", "https://api.typesafe.ai/v1/systemone", "personal"],
  ["typesafe", "jev-1.14", "https://api.typesafe.ai/v1/systemone", "included"],
  ["typesafe", "jev-latest", "https://api.typesafe.ai/v1/systemone", "personal"],
  ["typesafe", "jev-latest", "https://api.typesafe.ai/v1/systemone", "self-hosted"],
  ["openrouter", "typesafe/jev-1.14", "https://openrouter.ai/api/alpha/decisions", "self-hosted"],
  ["openrouter", "typesafe/jev-1.14", "https://openrouter.ai/api/alpha/decisions", "personal"],
  ["openrouter", "typesafe/jev-1.14", "https://openrouter.ai/api/alpha/decisions", "included"],
])(
  "sends a %s checker key only to its own endpoint (%s)",
  async (providerId, model, endpoint, funding) => {
    const included = funding === "included";
    const personal = funding === "personal";
    if (!included && !personal) vi.mocked(findConnectedModelCredential).mockResolvedValueOnce(null);
    vi.stubEnv("OPENROUTER_API_KEY", "fake-openrouter-operator-key");
    vi.stubEnv("TYPESAFE_API_KEY", "fake-typesafe-operator-key");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([id]) => [
            id,
            {
              type: "choice",
              choice: "ask",
              confidence: 1,
            },
          ]),
        ),
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.001 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const registerSecrets = vi.fn();
    const createUsage = vi.fn();
    const deps = {
      billingEnabled: included,
      prisma: {
        $transaction: async (work: (tx: unknown) => unknown) =>
          work({
            usageRecord: { createMany: createUsage, updateMany: vi.fn() },
            modelCreditEntry: { findUnique: async () => null },
          }),
      },
      secretStore: {},
    } as unknown as ExecutorDeps;
    const checker = await autoReviewCheckerProvider(
      deps,
      { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
      { memberChecker: personal, registerSecrets },
      { provider: providerId, model },
    );
    await checker.review(
      {
        toolName: "fixture_action",
        connectorKind: "fixture",
        args: {},
        userTask: "Review action",
        botDescription: "Fixture bot",
        matchingRules: [],
      },
      {
        operationId: "review",
        traceId: "review",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      },
    );
    if (!personal)
      expect(registerSecrets).toHaveBeenCalledWith([`fake-${providerId}-operator-key`]);
    expect(createUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ fundingSource: included ? "operator" : "customer" })],
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${personal ? "fixture-model-key" : `fake-${providerId}-operator-key`}`,
        }),
      }),
    );
  },
);
