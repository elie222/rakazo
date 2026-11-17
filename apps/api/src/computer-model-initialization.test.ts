import type { SecretStore } from "@rakazo/adapter-kit";
import { computerInitializationGrant, configuredModelAccount } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { mountComputerModelInitialization } from "./computer-model-initialization.js";
import { serializeModelAccountSecret } from "./model-account-secret.js";

const scope = { userId: "fixture-user", spaceId: "fixture-space", homeKey: "fixture-home" };
const grant = {
  ...scope,
  credentialId: "fixture-credential",
  credentialCreatedAt: "2026-01-01T00:00:00.000Z",
};
const signingKey = "fake-server-key";
const originalIdentity = {
  accountId: "fixture-account",
  binding: "fixture-binding",
  issuer: "https://identity.example.test",
  subject: "fixture-subject",
};

function fixture() {
  let apiKey = "fake-original-key",
    connected = true,
    validComputer = true,
    deactivated = false;
  let binding = originalIdentity.binding;
  const connection = configuredModelAccount(
    JSON.stringify({
      provider: "reseller",
      origin: "https://accounts.example.test",
      credential: "fake-app-key",
      baseUrl: "https://models.example.test/v1",
      defaults: {
        responses: "model-r",
        "anthropic-messages": "model-a",
        "chat-completions": "model-c",
      },
    }),
  )!;
  const ensure = vi
    .spyOn(connection.provider, "ensure")
    .mockResolvedValue({ apiKey: "fake-recovered-key" });
  const fetch = vi.fn(async () =>
    Response.json({ data: ["model-r", "model-a", "model-c"].map((id) => ({ id })) }),
  );
  const computer = {
    findFirst: vi.fn(async () => (validComputer ? { id: "fixture-computer" } : null)),
  };
  const prisma = {
    secret: {
      findFirst: vi.fn(async () => ({ id: "fixture-secret", ciphertext: "fake-ciphertext" })),
    },
    computer,
    user: {
      findUnique: vi.fn(async () => ({ deactivatedAt: deactivated ? new Date() : null })),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        email: "fixture@example.test",
      })),
    },
    spaceMember: {
      findFirst: vi.fn(async () => ({
        ...grant,
        member: { user: { email: "fixture@example.test" } },
      })),
    },
    userModelCredential: {
      findFirst: vi.fn(async () =>
        connected
          ? {
              id: "fixture-credential",
              secretId: "fixture-secret",
              createdAt: new Date(grant.credentialCreatedAt),
            }
          : null,
      ),
    },
  };
  const secrets = {
    load: vi.fn(async () =>
      serializeModelAccountSecret(
        {
          kind: "openai_compatible",
          baseUrl: connection.model.baseUrl,
          apiKey,
          enabledModelIds: ["model-r", "model-a", "model-c"],
        },
        originalIdentity,
      ),
    ),
  };
  const save = vi.fn(async (_owner, _identity, key: string) => {
    apiKey = key;
  });
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "unavailable" }, 503),
  );
  mountComputerModelInitialization(app, {
    key: signingKey,
    connection,
    prisma: prisma as unknown as PrismaClient,
    secrets: secrets as unknown as SecretStore,
    identity: async () => ({ ...originalIdentity, binding }),
    save,
    fetch,
  });
  return {
    ensure,
    fetch,
    save,
    secrets,
    computer,
    prisma,
    setConnected: (value: boolean) => {
      connected = value;
    },
    setComputer: (value: boolean) => {
      validComputer = value;
    },
    setDeactivated: () => {
      deactivated = true;
    },
    setBinding: () => {
      binding = "changed-binding";
    },
    request: (token = computerInitializationGrant(signingKey, grant)) =>
      app.request("/computer", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
  };
}

describe("computer model credentials", () => {
  it("returns only the current authorized personal connection with protocol defaults", async () => {
    const f = fixture(),
      response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiKey: "fake-original-key",
      baseUrl: "https://models.example.test/v1",
      defaults: { responses: "model-r" },
    });
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.computer.findFirst).toHaveBeenCalledWith({
      where: {
        ...scope,
        kind: "docker",
        scope: { in: ["team", "dedicated"] },
        space: {
          deletingAt: null,
          memberships: { some: { userId: scope.userId }, none: { userId: { not: scope.userId } } },
        },
        state: { in: ["running", "booting"] },
      },
    });
  });

  it("recovers exactly once after 401 and saves only a replacement that passes authentication", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await f.request();
    expect(response.status).toBe(200);
    expect((await response.json()).apiKey).toBe("fake-recovered-key");
    expect(f.ensure).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledOnce();
  });

  it.each([403, 429, 500, 503])("does not recover a key for status %s", async (status) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status }));
    expect((await f.request()).status).toBe(503);
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("stops when ensure returns the same invalid key or another invalid replacement", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    f.ensure.mockResolvedValueOnce({ apiKey: "fake-original-key" });
    expect((await f.request()).status).toBe(401);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.save).not.toHaveBeenCalled();
    f.fetch
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await f.request()).status).toBe(401);
    expect(f.ensure).toHaveBeenCalledTimes(2);
    expect(f.save).not.toHaveBeenCalled();
  });

  it("rejects forged grants, shared computers, revoked connections and disabled users before upstream calls", async () => {
    const f = fixture();
    expect((await f.request("forged-token")).status).toBe(401);
    expect(f.secrets.load).not.toHaveBeenCalled();
    f.setComputer(false);
    expect((await f.request()).status).toBe(403);
    f.setComputer(true);
    f.setConnected(false);
    expect((await f.request()).status).toBe(401);
    f.setConnected(true);
    f.setDeactivated();
    expect((await f.request()).status).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it("does not release a key after a disconnect, account switch or computer scope change during validation", async () => {
    for (const change of ["disconnect", "identity", "computer"] as const) {
      const f = fixture();
      f.fetch.mockImplementationOnce(async () => {
        if (change === "disconnect") f.setConnected(false);
        if (change === "identity") f.setBinding();
        if (change === "computer") f.setComputer(false);
        return Response.json({ data: [{ id: "model-r" }] });
      });
      expect((await f.request()).status).toBe(change === "computer" ? 403 : 401);
      expect(f.save).not.toHaveBeenCalled();
    }
  });
});
