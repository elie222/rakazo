import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent, SecretStore } from "@rakazo/adapter-kit";
import { EXECUTION_HARNESS_VERSIONS } from "@rakazo/contracts";
import type { ExecutionProfile, PrismaClient } from "@rakazo/db";
import { executionProfileSnapshot, resolveRunExecutionProfile } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { resolveProfileModel } from "./execution-profile-runtime.js";
import { PiAgentRuntime } from "./pi-runtime.js";

it("real Pi sends two exact profile accounts to the same provider/model without leaking keys into events", async () => {
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the local fixture request. */
    }
    observed.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish] of [
      [{ role: "assistant" }, null],
      [{ content: "Done." }, null],
      [{}, "stop"],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "offline-account-reply", object: "chat.completion.chunk", created: 0, model: "same-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback fixture address");
  const scope = { spaceId: "space", userId: "owner" };
  const credentials = ["a", "b"].map((id) => ({
    id: `account-${id}`,
    userId: scope.userId,
    provider: "openai-compatible",
    secretId: `secret-${id}`,
    label: `Account ${id}`,
  }));
  const profiles = credentials.map((credential) => ({
    ...scope,
    id: `profile-${credential.id}`,
    seriesId: `series-${credential.id}`,
    revision: 1,
    name: "Pi account",
    harness: "pi",
    provider: credential.provider,
    credentialId: credential.id,
    protocol: "openai-chat-completions",
    authScheme: "api-key",
    modelRoles: {},
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    modelId: "same-model",
    inputModalities: [],
    runtimeVersion: EXECUTION_HARNESS_VERSIONS.pi,
    computerId: null,
    createdAt: new Date(0),
  })) as ExecutionProfile[];
  const keys = new Map(
    credentials.map((credential) => [credential.secretId, `fake-key-${credential.id}`]),
  );
  const findCredential = vi.fn(
    async ({ where }: { where: { id: string; provider: string; userId: string } }) =>
      credentials.find(
        (row) =>
          row.id === where.id && row.provider === where.provider && row.userId === where.userId,
      ) ?? null,
  );
  const prisma = {
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; spaceId: string; userId: string } }) =>
          where.spaceId === scope.spaceId &&
          where.userId === scope.userId &&
          ["bot-0", "bot-1"].includes(where.id)
            ? { id: where.id }
            : null,
      ),
    },
    computer: { findFirst: vi.fn(async () => ({ id: "computer" })) },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "membership" })) },
    executionProfile: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          profiles.find((profile) => profile.id === where.id) ?? null,
      ),
    },
    userModelCredential: { findFirst: findCredential },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: null } }) =>
          where.userId === scope.userId && where.spaceId === null && keys.has(where.id)
            ? { id: where.id, ciphertext: "fake-ciphertext" }
            : null,
      ),
    },
  } as unknown as PrismaClient;
  const secretStore = {
    load: vi.fn(async (_ciphertext: string, id: string) => keys.get(id)!),
  } as unknown as SecretStore;
  const runtime = new PiAgentRuntime();
  const events: AgentRuntimeEvent[] = [];
  try {
    for (const [index, profile] of profiles.entries()) {
      const run = {
        ...scope,
        botId: `bot-${index}`,
        executionProfileSnapshot: executionProfileSnapshot(
          profile,
          credentials[index]!.secretId,
          "computer",
        ),
      };
      const binding = await resolveRunExecutionProfile(prisma, run);
      expect(binding?.credential.id).toBe(credentials[index]!.id);
      const resolved = await resolveProfileModel(
        { prisma, secretStore },
        scope,
        binding!.profile,
        binding!.credential,
      );
      for await (const event of runtime.run({
        botId: run.botId,
        threadId: `thread-${index}`,
        runId: `run-${index}`,
        prompt: "Say done.",
        history: [],
        instructions: "Reply briefly.",
        tools: [],
        model: resolved.model,
      }))
        events.push(event);
    }
    expect(observed).toEqual(
      credentials.map((credential) => `Bearer ${keys.get(credential.secretId)}`),
    );
    expect(findCredential.mock.calls.map(([input]) => input.where.id)).toEqual(
      credentials.map((credential) => credential.id),
    );
    expect(events.filter((event) => event.type === "done")).toHaveLength(2);
    for (const key of keys.values()) expect(JSON.stringify(events)).not.toContain(key);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
