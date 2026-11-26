import { EncryptedSecretStore, parseModelSecret } from "@rakazo/adapters";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { appHandler, handle } from "../router-test-support.js";
import { owner } from "./model-settings.test-support.js";

const input = {
  provider: "groq",
  modelId: "openai/gpt-oss-120b",
  label: "Team model",
  apiKey: "fixture-model-key",
};

function setup(role = "owner") {
  const secrets = new EncryptedSecretStore("fixture-encryption-key");
  const create = vi.fn().mockResolvedValue({
    id: "connection-one",
    provider: input.provider,
    modelId: input.modelId,
    label: input.label,
  });
  const member = { findFirst: vi.fn().mockResolvedValue(role === "guest" ? null : { role }) };
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "organization-one" }) },
    member,
    organizationModelConnection: { create, deleteMany },
  };
  const modelConnectionFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  const deps = {
    prisma: { ...tx, $transaction: async (work: (client: typeof tx) => unknown) => work(tx) },
    secrets,
    modelConnectionFetch,
    env: {},
  } as unknown as RouterDeps;
  const handler = appHandler(deps);
  const request = (action: string, json: unknown) =>
    handle(
      handler,
      new Request(`http://localhost/rpc/models/organizationConnections/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor: owner } },
    );
  return { request, create, deleteMany, member, lock: tx.$queryRaw, secrets, modelConnectionFetch };
}

it("seals an organization's model key and returns only its connection metadata", async () => {
  const { request, create, secrets } = setup("admin");
  const response = await request("create", input);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    json: {
      id: "connection-one",
      provider: input.provider,
      modelId: input.modelId,
      label: input.label,
    },
  });
  const { data } = create.mock.calls[0]![0];
  expect(data.organizationId).toBe("organization-one");
  expect(data.ciphertext).not.toContain(input.apiKey);
  expect(parseModelSecret(await secrets.load(data.ciphertext, data.secretId))).toMatchObject({
    kind: "api_key",
    key: input.apiKey,
  });
});

it.each(["member", "guest"])("refuses a %s before checking or saving the key", async (role) => {
  const { request, create, modelConnectionFetch } = setup(role);
  expect((await request("create", input)).status).toBe(403);
  expect(create).not.toHaveBeenCalled();
  expect(modelConnectionFetch).not.toHaveBeenCalled();
});

it("scopes connection removal to the admin's organization", async () => {
  const { request, deleteMany } = setup();
  expect((await request("remove", { id: "foreign-connection" })).status).toBe(404);
  expect(deleteMany).toHaveBeenCalledWith({
    where: { id: "foreign-connection", organizationId: "organization-one" },
  });
});

it("rechecks management permission before saving a verified key", async () => {
  const { request, create, member, lock } = setup("admin");
  lock.mockImplementationOnce(async () => {
    member.findFirst.mockResolvedValue({ role: "member" });
    return [];
  });

  expect((await request("create", input)).status).toBe(403);
  expect(create).not.toHaveBeenCalled();
});
