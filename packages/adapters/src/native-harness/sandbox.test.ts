import type { AdapterContext, CommandRequest, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { createRunSandbox } from "./../computers/sandbox/host-aware-sandbox.js";
import { readComputerInitializationGrant } from "./initialization-auth.js";
import { createInitializedRunSandbox } from "./sandbox.js";

vi.mock("../host-aware-sandbox.js", () => ({ createRunSandbox: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("preserves the generic provider when initialization is disabled or the computer is local", async () => {
  const provider = {} as SandboxProvider;
  vi.mocked(createRunSandbox).mockResolvedValue(provider);
  expect(await createInitializedRunSandbox("docker", {})).toBe(provider);
  for (const kind of ["desktop", "fake"]) {
    expect(
      await createInitializedRunSandbox(kind, {
        prisma: {} as PrismaClient,
        secrets: { load: vi.fn(), onChange: vi.fn(() => () => {}) },
        initialization: { url: "https://app.example.test", signingKey: "fake-signing-key" },
      }),
    ).toBe(provider);
  }
});

it("prepares the selected provider before installing an owner-scoped grant without forwarding its signing key", async () => {
  const order: string[] = [];
  const signingKey = "fake-signing-key";
  const credentialCreatedAt = new Date("2026-01-01T00:00:00.000Z");
  const context: AdapterContext = {
    spaceId: "fixture-space",
    userId: "fixture-user",
    operationId: "fixture-operation",
    traceId: "fixture-trace",
    signal: new AbortController().signal,
  };
  const prepare = vi.fn(async () => {
    order.push("prepare");
  });
  const execute = vi.fn(async function* (
    _computer: Parameters<SandboxProvider["execute"]>[0],
    request: CommandRequest,
  ) {
    order.push("initialize");
    expect(JSON.stringify(request)).not.toContain(signingKey);
    const connection = JSON.parse(request.env!.COMPUTER_MODEL_INITIALIZATION!);
    expect(readComputerInitializationGrant(signingKey, connection.token)).toEqual({
      userId: context.userId,
      spaceId: context.spaceId,
      homeKey: "fixture-home",
      credentialId: "external-fixture",
      credentialCreatedAt: credentialCreatedAt.toISOString(),
    });
    yield { type: "exit" as const, code: 0 };
  });
  const provider = { prepare, execute } as unknown as SandboxProvider;
  vi.mocked(createRunSandbox).mockResolvedValue(provider);
  const prisma = {
    computer: { findFirst: vi.fn(async () => ({ homeKey: "fixture-home" })) },
    userModelCredential: {
      findFirst: vi.fn(async () => ({ id: "external-fixture", createdAt: credentialCreatedAt })),
    },
  } as unknown as PrismaClient;
  const secrets = { load: vi.fn(), onChange: vi.fn(() => () => {}) };
  const sandbox = await createInitializedRunSandbox("docker", {
    prisma,
    secrets,
    initialization: { url: "https://app.example.test", signingKey },
  });
  expect(createRunSandbox).toHaveBeenCalledExactlyOnceWith("docker", { prisma, secrets });
  await sandbox.prepare(
    { id: "fixture-computer", kind: "docker", botId: "fixture-home", providerRef: "fixture" },
    context,
  );
  expect(order).toEqual(["prepare", "initialize"]);
});
