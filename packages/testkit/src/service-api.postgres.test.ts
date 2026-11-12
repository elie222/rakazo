import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import type { Actor, Bot, ServiceCredential, ServiceScope } from "@rakazo/contracts";
import { SERVICE_CREDENTIALS_PER_MEMBER } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const BASE = "/api/service/v1/bots";
const ORIGIN = "http://127.0.0.1:5173";

describeWithDatabase("service API", () => {
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-service-api-"));
  let sequence = 0;

  const call = async <T>(cookie: string, procedure: string, body: unknown = {}) => {
    const response = await app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T };
    return { status: response.status, json: payload.json as T };
  };
  const must = async <T>(cookie: string, procedure: string, body: unknown = {}) => {
    const result = await call<T>(cookie, procedure, body);
    if (result.status >= 400) throw new Error(`${procedure} ${result.status}`);
    return discardBotIntroFromCreate(handles as BotIntroHarness, cookie, procedure, result.json);
  };

  const person = async () => {
    sequence += 1;
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `service-${sequence}-${stamp}@rakazo.test`,
        password: "password12",
        name: `Service ${sequence}`,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const confirmed = await app.request("/api/auth/confirm-identity", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ password: "password12" }),
    });
    expect(confirmed.status).toBe(200);
    return { cookie, actor: await must<Actor>(cookie, "me") };
  };
  const newBot = (cookie: string, name: string) =>
    must<Bot>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  const newKey = (cookie: string, options: { scopes?: ServiceScope[]; botIds?: string[] } = {}) =>
    must<{ credential: ServiceCredential; token: string }>(cookie, "serviceCredentials/create", {
      name: `key-${crypto.randomUUID().slice(0, 8)}`,
      scopes: options.scopes ?? ["bots:read", "conversations:read", "prompts:write"],
      botIds: options.botIds ?? [],
      expiresInDays: 30,
    });

  const get = (token: string | null, suffix = "") =>
    app.request(`${BASE}${suffix}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const prompt = (token: string, botId: string, text: string, key: string) =>
    app.request(`${BASE}/${botId}/prompts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ text }),
    });

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "offline-service-api-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
    db = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("needs a confirmed identity to create a key, and shows the token only once", async () => {
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `unconfirmed-${stamp}@rakazo.test`,
        password: "password12",
        name: "Unconfirmed",
      }),
    });
    const refused = await call(sessionCookieHeader(response), "serviceCredentials/create", {
      name: "nope",
      scopes: ["bots:read"],
      expiresInDays: 30,
    });
    expect(refused.status).toBe(403);

    const { cookie } = await person();
    const { credential, token } = await newKey(cookie);
    expect(token).toMatch(/^rks_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(credential.tokenPrefix)).toBe(true);
    const row = await db.serviceCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(JSON.stringify(row)).not.toContain(token);
    const listed = await must<ServiceCredential[]>(cookie, "serviceCredentials/list");
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
  });

  it("does not let a service token into the session API", async () => {
    const { cookie } = await person();
    const { token } = await newKey(cookie);
    const response = await app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects missing, malformed and unknown tokens the same way", async () => {
    for (const token of [null, "nope", `rks_${"a".repeat(43)}`]) {
      const response = await get(token);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("reads only the creator's bots and answers one 404 for everything else", async () => {
    const owner = await person();
    const stranger = await person();
    const bot = await newBot(owner.cookie, "Owned");
    const archived = await newBot(owner.cookie, "Archived");
    await must(owner.cookie, "bots/archive", { botId: archived.id });
    const foreign = await newBot(stranger.cookie, "Foreign");
    const { token } = await newKey(owner.cookie);

    const list = (await (await get(token)).json()) as {
      bots: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    };
    const ids = list.bots.map((entry) => entry.id);
    expect(ids).toContain(bot.id);
    expect(ids).not.toContain(archived.id);
    expect(ids).not.toContain(foreign.id);
    expect(list.nextCursor).toBeNull();

    const status = await get(token, `/${bot.id}/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ botId: bot.id, name: "Owned", runs: [] });
    // The computer's state is for keys that may read the computer.
    expect(body).not.toHaveProperty("computer");
    const computerReader = await newKey(owner.cookie, { scopes: ["bots:read", "computer:read"] });
    const withComputer = await get(computerReader.token, `/${bot.id}/status`);
    expect(await withComputer.json()).toMatchObject({
      computer: { state: expect.any(String), screenAvailable: expect.any(Boolean) },
    });

    const answers = await Promise.all(
      [foreign.id, archived.id, "missing-bot"].map(async (id) => {
        const response = await get(token, `/${id}/status`);
        return [response.status, await response.text()];
      }),
    );
    expect(answers[0]?.[0]).toBe(404);
    expect(new Set(answers.map((answer) => answer[1])).size).toBe(1);
  });

  it("enforces scopes and the bot list", async () => {
    const { cookie } = await person();
    const allowed = await newBot(cookie, "Allowed");
    const other = await newBot(cookie, "Other");
    const reader = await newKey(cookie, { scopes: ["bots:read"], botIds: [allowed.id] });
    const writer = await newKey(cookie, { scopes: ["prompts:write"] });

    expect((await prompt(reader.token, allowed.id, "hi", "reader")).status).toBe(403);
    expect((await get(writer.token)).status).toBe(403);
    const list = (await (await get(reader.token)).json()) as { bots: Array<{ id: string }> };
    expect(list.bots.map((entry) => entry.id)).toEqual([allowed.id]);
    expect((await get(reader.token, `/${other.id}/status`)).status).toBe(404);

    const foreignBot = await newBot((await person()).cookie, "Theirs");
    const refused = await call(cookie, "serviceCredentials/create", {
      name: "foreign",
      scopes: ["bots:read"],
      botIds: [foreignBot.id],
      expiresInDays: 30,
    });
    expect(refused.status).toBe(404);
  });

  it("validates requests before they reach a bot", async () => {
    const { cookie } = await person();
    const bot = await newBot(cookie, "Strict");
    const { token } = await newKey(cookie);
    const headers = { authorization: `Bearer ${token}` };
    const post = (extra: Record<string, string>, body: string) =>
      app.request(`${BASE}/${bot.id}/prompts`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body,
      });
    const json = { "content-type": "application/json" };
    const keyed = { ...json, "idempotency-key": "k1" };

    expect((await app.request(`${BASE}/${bot.id}/prompts`, { headers })).status).toBe(405);
    expect((await post({ "idempotency-key": "k1" }, "{}")).status).toBe(415);
    expect((await post(json, '{"text":"hi"}')).status).toBe(400);
    expect((await post(keyed, "not json")).status).toBe(400);
    expect((await post(keyed, '{"text":"hi","extra":1}')).status).toBe(400);
    expect((await post(keyed, '{"text":" padded "}')).status).toBe(400);
    expect((await post(keyed, JSON.stringify({ text: "x".repeat(8001) }))).status).toBe(400);
    expect((await post(keyed, JSON.stringify({ text: "x".repeat(40000) }))).status).toBe(413);
    expect((await get(token, "?unknown=1")).status).toBe(400);
    expect((await get(token, `/${bot.id}/activity?before=-1`)).status).toBe(400);
    expect((await get(token, "/nothing/here/at/all")).status).toBe(404);
  });

  it("delivers a prompt once per key, and audits it against the key", async () => {
    const { cookie, actor } = await person();
    const bot = await newBot(cookie, "Worker");
    const first = await newKey(cookie);
    const second = await newKey(cookie);

    const sent = await prompt(first.token, bot.id, "first prompt", "same-key");
    expect(sent.status).toBe(200);
    const receipt = (await sent.json()) as { runId: string; seq: number };

    const replay = await prompt(first.token, bot.id, "first prompt", "same-key");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ runId: receipt.runId, seq: receipt.seq });

    const conflict = await prompt(first.token, bot.id, "different prompt", "same-key");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    // Another key's value is its own namespace, so it is a new prompt rather than a conflict.
    const separate = await prompt(second.token, bot.id, "another prompt", "same-key");
    expect(separate.status).toBe(200);
    expect(((await separate.json()) as { seq: number }).seq).toBeGreaterThan(receipt.seq);

    const activity = (await (await get(first.token, `/${bot.id}/activity`)).json()) as {
      messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
    };
    const texts = activity.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.blocks.flatMap((block) => block.text ?? []));
    expect(texts).toEqual(["first prompt", "another prompt"]);

    const audited = await db.auditEvent.findMany({
      where: { action: "service_api.prompt", actorId: first.credential.id },
    });
    // The replay and the refused conflict add nothing.
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actorType: "service",
      spaceId: actor.spaceId,
      targetType: "bot",
      targetId: bot.id,
      runId: receipt.runId,
    });
    expect(JSON.stringify(audited)).not.toContain("first prompt");

    // A request that died between the send and its audit leaves the retry to write it.
    await db.auditEvent.deleteMany({ where: { id: audited[0]!.id } });
    expect((await prompt(first.token, bot.id, "first prompt", "same-key")).status).toBe(200);
    expect((await prompt(first.token, bot.id, "first prompt", "same-key")).status).toBe(200);
    expect(
      await db.auditEvent.count({
        where: { action: "service_api.prompt", actorId: first.credential.id },
      }),
    ).toBe(1);
  });

  it("stops working when revoked, expired or when the creator leaves the space", async () => {
    const { cookie, actor } = await person();
    const revoked = await newKey(cookie);
    const expired = await newKey(cookie);
    const departed = await newKey(cookie);
    for (const key of [revoked, expired, departed]) {
      expect((await get(key.token)).status).toBe(200);
    }

    await must(cookie, "serviceCredentials/revoke", { id: revoked.credential.id });
    expect((await get(revoked.token)).status).toBe(401);
    await must(cookie, "serviceCredentials/revoke", { id: revoked.credential.id });
    expect(
      await db.auditEvent.count({
        where: { action: "service_credential.revoked", targetId: revoked.credential.id },
      }),
    ).toBe(1);

    await db.serviceCredential.update({
      where: { id: expired.credential.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await get(expired.token)).status).toBe(401);

    await db.spaceMember.deleteMany({ where: { userId: actor.userId, spaceId: actor.spaceId } });
    expect((await get(departed.token)).status).toBe(401);
  });

  it("stops working once the creator's account is deactivated", async () => {
    const { cookie, actor } = await person();
    const { token } = await newKey(cookie);
    expect((await get(token)).status).toBe(200);
    // Deactivation sets the flag before its cleanup steps run; the key must stop on the flag alone.
    await db.user.update({ where: { id: actor.userId }, data: { deactivatedAt: new Date() } });
    expect((await get(token)).status).toBe(401);
  });

  it("will not revoke another member's key", async () => {
    const owner = await person();
    const { credential, token } = await newKey(owner.cookie);
    const refused = await call((await person()).cookie, "serviceCredentials/revoke", {
      id: credential.id,
    });
    expect(refused.status).toBe(404);
    expect((await get(token)).status).toBe(200);
  });

  it("lets concurrent creations at the limit make only one more key", async () => {
    const { cookie, actor } = await person();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.serviceCredential.createMany({
      data: Array.from({ length: SERVICE_CREDENTIALS_PER_MEMBER - 1 }, (_, index) => ({
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: `seed-${index}`,
        tokenHash: `seed-${stamp}-${index}`,
        tokenPrefix: "rks_seed",
        scopes: ["bots:read"],
        botIds: [],
        expiresAt,
      })),
    });
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(cookie, "serviceCredentials/create", {
          name: "racing",
          scopes: ["bots:read"],
          expiresInDays: 30,
        }),
      ),
    );
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 400, 400, 400, 400]);
    expect(
      await db.serviceCredential.count({
        where: { userId: actor.userId, spaceId: actor.spaceId, revokedAt: null },
      }),
    ).toBe(SERVICE_CREDENTIALS_PER_MEMBER);
  });

  it("limits each key per minute and resets when the window passes", async () => {
    const { cookie } = await person();
    const busy = await newKey(cookie);
    const quiet = await newKey(cookie);
    await db.serviceCredential.update({
      where: { id: busy.credential.id },
      data: { windowCount: 120, windowStartedAt: new Date() },
    });
    const limited = await get(busy.token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await get(quiet.token)).status).toBe(200);

    await db.serviceCredential.update({
      where: { id: busy.credential.id },
      data: { windowStartedAt: new Date(Date.now() - 61_000) },
    });
    expect((await get(busy.token)).status).toBe(200);
  });

  it("records the key's lifecycle and last use", async () => {
    const { cookie, actor } = await person();
    const { credential, token } = await newKey(cookie);
    expect(credential.lastUsedAt).toBeNull();
    await get(token);
    const [listed] = await must<ServiceCredential[]>(cookie, "serviceCredentials/list");
    expect(listed?.lastUsedAt).not.toBeNull();
    const created = await db.auditEvent.findFirst({
      where: { action: "service_credential.created", targetId: credential.id },
    });
    expect(created).toMatchObject({ actorType: "user", actorId: actor.userId });
  });
});
