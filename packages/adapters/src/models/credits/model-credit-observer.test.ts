import type { ModelCallObserver } from "@rakazo/adapter-kit";
import {
  creditAccount,
  organizationForMember,
  recordModelCreditReceipt,
  reserveModelCredits,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpDecisionProvider } from "../../approvals/http-decisions.js";
import { hostedModelCreditObserver } from "./model-credit-observer.js";

vi.mock("@rakazo/db", () => ({
  organizationForMember: vi.fn(),
  creditAccount: vi.fn(),
  reserveModelCredits: vi.fn(),
  recordModelCreditReceipt: vi.fn(),
}));

const scope = { userId: "user-1", spaceId: "space-1" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(organizationForMember).mockResolvedValue({ organizationId: "org-1" } as never);
});

describe("hosted model credit gate", () => {
  it("refuses an unfunded BYOK account even if old owner and subscription records exist", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "byok", balanceMicros: 0n } as never);
    const findUnique = vi.fn(async () => ({ ownerUserId: scope.userId, status: "active" }));
    await expect(
      hostedModelCreditObserver(
        { deploymentSettings: { findUnique }, billingAccount: { findUnique } } as never,
        scope,
      ),
    ).rejects.toThrow("Connect your own API key");
    expect(findUnique).not.toHaveBeenCalled();
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
  it("lets a BYOK account with a balance reserve credits", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "byok", balanceMicros: 1n } as never);
    await expect(hostedModelCreditObserver({} as never, scope)).resolves.toBeDefined();
  });
  it("requires a reservation before a funded-mode account may use the server key", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
    vi.mocked(reserveModelCredits).mockRejectedValue(new Error("Not enough model credits"));
    const observer = await hostedModelCreditObserver({} as never, scope);
    const call = {
      callId: "call-1",
      maxCostUsd: 0.02,
      provider: "test-provider",
      modelId: "test-model",
      runId: "run-1",
    } as Parameters<ModelCallObserver["beforeCall"]>[0];
    await expect(observer.beforeCall(call)).rejects.toThrow("Not enough model credits");
    expect(reserveModelCredits).toHaveBeenCalledWith({}, "org-1", 0.02, {
      ...scope,
      callId: "call-1",
      runId: "run-1",
      provider: "test-provider",
      model: "test-model",
    });
  });
});

afterEach(() => vi.unstubAllEnvs());
describe("approved model tariffs", () => {
  const entry = {
    id: "approved",
    connectionId: "operator-connection",
    provider: "provider-a",
    modelId: "model-a",
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
  };
  const configure = () => {
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({ defaultOfferingId: entry.id, offerings: [entry] }),
    );
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
  };
  const call = {
    provider: entry.provider,
    modelId: entry.modelId,
    inputTokensEstimate: 1000000,
    maxOutputTokens: 1000000,
  };
  it("rejects unapproved auxiliary and backup calls before reserving", async () => {
    configure();
    const observer = await hostedModelCreditObserver({} as never, scope);
    await expect(observer.beforeCall({ ...call, modelId: "unapproved" })).rejects.toThrow(
      "personal connection",
    );
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
  it("isolates concurrent calls and retains their tariff after withdrawal", async () => {
    configure();
    vi.mocked(reserveModelCredits).mockImplementation(
      async (_db, _org, _cost, attribution) => attribution!.callId!,
    );
    const observer = await hostedModelCreditObserver({} as never, scope);
    await Promise.all([
      observer.beforeCall({ ...call, callId: "call-a" }),
      observer.beforeCall({ ...call, callId: "call-b" }),
    ]);
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({ defaultOfferingId: null, offerings: [] }),
    );
    const usage = {
      inputTokens: 1000000,
      outputTokens: 1000000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costSource: "provider-reported",
    };
    const results = await Promise.all([
      observer.afterCall("call-b", usage),
      observer.afterCall("call-a", usage),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ costUsd: 3 }),
      expect.objectContaining({ costUsd: 3 }),
    ]);
    expect(recordModelCreditReceipt).toHaveBeenCalledWith(
      {},
      "call-a",
      expect.objectContaining({ costUsd: 3 }),
    );
    expect(reserveModelCredits).toHaveBeenCalledWith(
      {},
      "org-1",
      3,
      expect.objectContaining({
        usage: expect.objectContaining({
          costUsd: null,
          pricingSnapshot: expect.objectContaining({ connectionId: "operator-connection" }),
        }),
      }),
    );
    const withdrawn = await hostedModelCreditObserver({} as never, scope);
    await expect(withdrawn.beforeCall(call)).rejects.toThrow("personal connection");
  });
});

it("releases an unsent tariff call while retaining a pending tariff before dispatch", async () => {
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({
      defaultOfferingId: "decision",
      offerings: [
        {
          id: "decision",
          connectionId: "operator",
          provider: "decision-provider",
          modelId: "decision-model",
          price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    }),
  );
  vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
  vi.mocked(reserveModelCredits).mockResolvedValue("hold");
  const observer = await hostedModelCreditObserver({} as never, scope);
  await observer.beforeCall({
    provider: "decision-provider",
    modelId: "decision-model",
    inputTokensEstimate: 100,
    maxOutputTokens: null,
  });
  expect(reserveModelCredits).toHaveBeenCalledWith(
    {},
    "org-1",
    0.0001,
    expect.objectContaining({
      usage: expect.objectContaining({
        costUsd: null,
        usageSource: "pending",
        pricingVersion: "deployment-tariff:decision",
      }),
    }),
  );
  await expect(observer.afterCall("hold", null)).resolves.toMatchObject({
    costUsd: 0,
    usageSource: "not-started",
  });
  expect(recordModelCreditReceipt).toHaveBeenCalledWith(
    {},
    "hold",
    expect.objectContaining({ costUsd: 0, usageSource: "not-started" }),
  );
});
it("refuses a paid output tariff when the protocol cannot bound output", async () => {
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({
      defaultOfferingId: "decision",
      offerings: [
        {
          id: "decision",
          connectionId: "operator",
          provider: "decision-provider",
          modelId: "decision-model",
          price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    }),
  );
  vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
  const observer = await hostedModelCreditObserver({} as never, scope);
  await expect(
    observer.beforeCall({
      provider: "decision-provider",
      modelId: "decision-model",
      inputTokensEstimate: 100,
      maxOutputTokens: null,
    }),
  ).rejects.toThrow("zero output tariff");
  expect(reserveModelCredits).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains uncertain decision holds and releases only pre-dispatch cancellation (unsent=%s)",
  async (unsent) => {
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({
        defaultOfferingId: "decision",
        offerings: [
          {
            id: "decision",
            connectionId: "operator",
            provider: "openrouter",
            modelId: "typesafe/jev-1.14",
            price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
    );
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
    const controller = new AbortController();
    vi.mocked(reserveModelCredits).mockImplementation(async () => {
      if (unsent) controller.abort();
      return "hold";
    });
    const observer = await hostedModelCreditObserver({} as never, scope);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("response lost");
    });
    const provider = new HttpDecisionProvider("openrouter", {
      apiKey: "fake-key",
      callObserver: observer,
      fetch: fetchMock,
    });
    await expect(
      provider.decide(
        { model: "typesafe/jev-1.14", state: {}, questions: {} },
        {
          operationId: "decision",
          traceId: "decision",
          ...scope,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(unsent ? 0 : 1);
    expect(recordModelCreditReceipt).toHaveBeenCalledWith(
      {},
      "hold",
      expect.objectContaining({
        costUsd: unsent ? 0 : null,
        usageSource: unsent ? "not-started" : "unavailable",
        pricingVersion: "deployment-tariff:decision",
      }),
    );
  },
);
