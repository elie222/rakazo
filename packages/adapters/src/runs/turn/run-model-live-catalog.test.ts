import { expect, it, vi } from "vitest";
import type * as ModelSelectionModule from "../../models/model-selection.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveConnectedModelKey } from "./run-model.js";

const { validate } = vi.hoisted(() => ({
  validate: vi.fn(async (): Promise<string | undefined> => "stop-before-credentials"),
}));
vi.mock("../../models/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelectionModule>()),
  validateConnectedModelChoice: validate,
  findConnectedModelCredential: vi.fn(async () => ({
    id: "fixture-connection",
    secretId: "fixture-secret",
    provider: "anthropic",
    defaultModel: null,
  })),
}));
it("validates live-only models against the caller's account catalog before reading credentials", async () => {
  const catalog = { read: vi.fn() };
  const deps = {
    prisma: {},
    secretStore: {},
    billingEnabled: false,
    codexCatalog: catalog,
  } as unknown as ExecutorDeps;
  const scope = { userId: "fixture-user", spaceId: "fixture-space" };
  await expect(
    resolveConnectedModelKey(
      deps,
      scope,
      "openai-codex",
      "fixture-live-only",
      undefined,
      true,
      "fixture-connection",
    ),
  ).rejects.toThrow("stop-before-credentials");
  expect(validate).toHaveBeenCalledWith(
    deps.prisma,
    deps.secretStore,
    scope,
    "openai-codex",
    "fixture-live-only",
    expect.objectContaining({ credentialId: "fixture-connection", codexCatalog: catalog }),
  );
});

it("refuses a run on a stored connection to a provider the allowlist leaves out", async () => {
  const savedAllowlist = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
  process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
  try {
    validate.mockResolvedValueOnce(undefined);
    const deps = {
      prisma: {},
      secretStore: {},
      billingEnabled: false,
    } as unknown as ExecutorDeps;
    await expect(
      resolveConnectedModelKey(
        deps,
        { userId: "fixture-user", spaceId: "fixture-space" },
        "anthropic",
        "claude-haiku-5-5",
        undefined,
        true,
        "fixture-connection",
      ),
    ).rejects.toThrow("This model provider is not allowed on this server.");
  } finally {
    if (savedAllowlist === undefined) delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    else process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = savedAllowlist;
    validate.mockReset();
    validate.mockImplementation(async () => "stop-before-credentials");
  }
});
