import { createHash, randomBytes } from "node:crypto";
import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import type { configuredModelAccount } from "@rakazo/adapters";
import {
  discoverModelAccountModels,
  ExternalModelAccountError,
  parseModelSecret,
  readHomeNavigation,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import { readExternalAccountIdentity } from "@rakazo/auth/identity";
import type { Actor } from "@rakazo/contracts";
import { modelAccountSettingsSchema, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  deleteUnreferencedCredentialSecret,
  Prisma,
  requireMembership,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  initializeRunningModelComputers,
  mountComputerModelInitialization,
} from "./computer-model-initialization.js";
import { parseModelAccountSecret, serializeModelAccountSecret } from "./model-account-secret.js";

type Connection = NonNullable<ReturnType<typeof configuredModelAccount>>;
const CALLBACK = "/api/model-account/callback";
const TTL = 5 * 60_000;
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieName = (id: string) => `__Host-model-${id}`;

type Transaction = {
  sessionId: string;
  accountId: string;
  binding: string;
  verifier: string;
  browserProof: string;
  launched: boolean;
  phase: "pending" | "exchanging";
  native: boolean;
  returnTo?: string;
  credentialVersion: string;
};

export function modelAccountRoutes(deps: {
  connection: Connection | undefined;
  modelAccountOnly?: boolean;
  defaultModel?: string;
  prisma: PrismaClient;
  auth: Auth;
  secrets: SecretStore;
  issuer?: string;
  modelFetch?: typeof fetch;
  navigationFetch?: typeof fetch;
  webOrigin: string;
  authUrl: string;
  initializationKey?: string;
  sandbox?: SandboxProvider;
}) {
  const { connection, prisma, auth, secrets } = deps;
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 4096 }));
  app.use("*", (_c, next) => runAsSystem("external model account", next));
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof ExternalModelAccountError)
      return c.json({ error: error.reason }, error.reason === "authorization_required" ? 403 : 503);
    getLogger().warn("Model account operation failed", { operation: c.req.routePath });
    return c.json({ error: "unavailable" }, 503);
  });
  const currentIdentity = async (userId: string) =>
    readExternalAccountIdentity(prisma, userId, deps.issuer, (await auth.$context).secretConfig);
  const identity = async (userId: string) => {
    const value = await currentIdentity(userId);
    if (!value) throw new HTTPException(403, { message: "link_required" });
    return value;
  };
  const session = (request: Request) => auth.api.getSession({ headers: request.headers });
  const actor = async (userId: string, spaceId?: string | null) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true },
    });
    return requireMembership(prisma, user, spaceId ?? null);
  };
  const save = async (
    owner: Actor,
    expected: { accountId: string; binding: string },
    apiKey: string,
    transaction?: { id: string; ciphertext: string },
    requireCatalog = false,
    expectedSecretId?: string,
  ) => {
    if (!connection) throw new Error("Disabled");
    const current = await identity(owner.userId);
    if (current.accountId !== expected.accountId || current.binding !== expected.binding)
      throw new Error("Account binding changed");
    const externalAccount = { accountId: current.accountId, binding: current.binding };
    const priorCredential = await prisma.userModelCredential.findFirst({
      where: { id: `external-${current.accountId}`, userId: owner.userId },
    });
    if (expectedSecretId && priorCredential?.secretId !== expectedSecretId)
      throw new HTTPException(409, { message: "unavailable" });
    if (requireCatalog && !priorCredential)
      throw new HTTPException(403, { message: "authorization_required" });
    const previousRow =
      priorCredential &&
      (await prisma.secret.findUnique({ where: { id: priorCredential.secretId } }));
    const previousConfig = previousRow
      ? parseModelSecret(await secrets.load(previousRow.ciphertext, previousRow.id))
      : undefined;
    const configured =
      previousConfig?.kind === "openai_compatible" ? previousConfig : connection.model;
    let models = configured.enabledModelIds;
    try {
      models = await discoverModelAccountModels(connection.model.baseUrl, apiKey, deps.modelFetch);
    } catch (error) {
      if (requireCatalog) throw error;
      /* Authorization remains valid when model discovery is temporarily unavailable. */
    }
    const plaintext = serializeModelAccountSecret(
      {
        ...connection.model,
        apiProtocol: configured.apiProtocol ?? "chat-completions",
        enabledModelIds: models,
        apiKey,
      },
      externalAccount,
    );
    const stored = await secrets.put(plaintext, {
      ...owner,
      operationId: "model-account",
      traceId: "model-account",
      signal: AbortSignal.timeout(10_000),
    });
    const id = `external-${current.accountId}`;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "account" WHERE "id" = ${current.accountId} FOR UPDATE`,
      );
      if (transaction) {
        const consumed = await tx.modelOAuthSession.deleteMany({ where: transaction });
        if (consumed.count !== 1) throw new Error("Authorization cancelled");
      }
      const account = await tx.account.findFirst({
        where: {
          id: current.accountId,
          userId: owner.userId,
          accountId: current.binding,
          providerId: "oidc",
        },
      });
      if (!account) throw new Error("Account binding changed");
      const previous = await tx.userModelCredential.findUnique({ where: { id } });
      if (previous && previous.userId !== owner.userId) throw new Error("Invalid owner");
      if ((previous?.secretId ?? null) !== (priorCredential?.secretId ?? null))
        throw new HTTPException(409, { message: "unavailable" });
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: owner.userId,
          spaceId: null,
          kind: "model",
          ciphertext: stored.ciphertext,
        },
      });
      await tx.userModelCredential.upsert({
        where: { id },
        create: {
          id,
          userId: owner.userId,
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          label: "Model account",
          secretId: stored.id,
        },
        update: { secretId: stored.id },
      });
      if (deps.defaultModel) {
        // The primary key makes initialization race-safe with a user's own model selection.
        await tx.userModelRoleChoice.createMany({
          data: [
            {
              userId: owner.userId,
              role: "main",
              position: 0,
              provider: OPENAI_COMPATIBLE_PROVIDER_ID,
              modelId: deps.defaultModel,
              credentialId: id,
            },
          ],
          skipDuplicates: true,
        });
      }
      await tx.modelOAuthSession.deleteMany({
        where: { userId: owner.userId, provider: "external-model-revoke", scope: current.binding },
      });
      if (previous)
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: id,
          secretId: previous.secretId,
        });
    });
    await initializeRunningModelComputers(prisma, deps.sandbox, owner);
  };
  mountComputerModelInitialization(app, {
    key: deps.initializationKey,
    authUrl: deps.authUrl,
    connection,
    prisma,
    secrets,
    identity,
    save: (owner, current, apiKey, expectedSecretId) =>
      save(owner, current, apiKey, undefined, true, expectedSecretId),
    fetch: deps.modelFetch,
  });
  app.get("/oidc", async (c) => {
    if (!connection) return c.text("Not available", 404);
    const headers = new Headers(c.req.raw.headers);
    headers.set("origin", deps.webOrigin);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const response = await auth.handler(
      new Request(new URL("/api/auth/sign-in/social", deps.authUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "oidc",
          disableRedirect: true,
          callbackURL: new URL("/app", deps.webOrigin).href,
          newUserCallbackURL: new URL("/onboarding", deps.webOrigin).href,
          errorCallbackURL: new URL("/sign-in", deps.webOrigin).href,
        }),
      }),
    );
    if (!response.ok) return c.redirect(new URL("/sign-in", deps.webOrigin).href);
    const body = (await response.json()) as { url?: string };
    if (!body.url || new URL(body.url).protocol !== "https:")
      return c.text("Sign-in unavailable", 503);
    const result = new Headers({
      location: body.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    for (const cookie of response.headers.getSetCookie()) result.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers: result });
  });
  app.get("/config", async (c) => {
    if (!connection)
      return c.json({
        enabled: false,
        ...(deps.modelAccountOnly ? { modelAccountOnly: true } : {}),
      });
    const navigation = await readHomeNavigation(
      connection.navigationOrigin,
      deps.navigationFetch,
    ).catch(() => undefined);
    return c.json({
      enabled: true,
      serviceName: connection.serviceName,
      ...(deps.modelAccountOnly ? { modelAccountOnly: true } : {}),
      navigation,
      // Installed clients still validate these derived fields in the original response envelope.
      ...(navigation ? { ...navigation.defaults, modelId: "" } : {}),
    });
  });
  app.get("/status", async (c) => {
    if (!connection) return c.json({ enabled: false, connected: false });
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const current = await currentIdentity(signed.user.id);
    const credential = current
      ? await prisma.userModelCredential.findFirst({
          where: { id: `external-${current.accountId}`, userId: signed.user.id },
        })
      : null;
    let connected = false;
    let apiProtocol: "chat-completions" | "responses" | undefined;
    if (credential && current) {
      const secret = await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: signed.user.id },
      });
      if (secret) {
        const { secret: parsed, binding } = parseModelAccountSecret(
          await secrets.load(secret.ciphertext, secret.id),
        );
        if (parsed.kind === "openai_compatible")
          apiProtocol = parsed.apiProtocol === "responses" ? "responses" : "chat-completions";
        connected =
          parsed.kind === "openai_compatible" &&
          Boolean(parsed.apiKey) &&
          binding?.binding === current.binding &&
          binding.accountId === current.accountId;
      }
    }
    const pending = await prisma.modelOAuthSession.findFirst({
      where: { userId: signed.user.id, provider: "external-model", scope: signed.session.id },
      orderBy: { createdAt: "desc" },
    });
    let recovery:
      | "authorization_required"
      | "authorization_pending"
      | "authorization_unknown"
      | "revocation_unknown"
      | undefined;
    if (credential && current && !connected) recovery = "authorization_required";
    if (pending?.ciphertext) {
      const transaction = JSON.parse(
        await secrets.load(pending.ciphertext, pending.id),
      ) as Transaction;
      if (transaction.phase === "exchanging") recovery = "authorization_unknown";
      else if (pending.createdAt.getTime() > Date.now() - TTL) recovery = "authorization_pending";
    }
    if (
      current &&
      (await prisma.modelOAuthSession.findFirst({
        where: {
          userId: signed.user.id,
          provider: "external-model-revoke",
          scope: current.binding,
        },
      }))
    )
      recovery = "revocation_unknown";
    return c.json({
      enabled: true,
      connected,
      ...(connected && credential ? { credentialId: credential.id } : {}),
      linked: Boolean(current),
      ...(connected ? { apiProtocol } : {}),
      ...(recovery ? { recovery } : {}),
    });
  });
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const origin = c.req.header("origin");
    const native = origin === "rakazo://" && Boolean(c.req.header("authorization"));
    if (origin !== new URL(deps.webOrigin).origin && !native)
      return c.json({ error: "forbidden" }, 403);
    if (Number(c.req.header("content-length") ?? 0) > 4096)
      return c.json({ error: "invalid_request" }, 400);
    return next();
  });
  app.post("/settings", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const current = await identity(signed.user.id);
    const owner = await actor(signed.user.id);
    const parsedInput = modelAccountSettingsSchema.safeParse(await c.req.json());
    if (!parsedInput.success) return c.json({ error: "invalid_request" }, 400);
    const input = parsedInput.data;
    const credential = await prisma.userModelCredential.findFirst({
      where: { id: `external-${current.accountId}`, userId: signed.user.id },
    });
    if (!credential) return c.json({ error: "authorization_required" }, 403);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: credential.secretId } });
    const { secret, binding } = parseModelAccountSecret(await secrets.load(row.ciphertext, row.id));
    if (
      secret.kind !== "openai_compatible" ||
      !secret.apiKey ||
      binding?.binding !== current.binding ||
      binding.accountId !== current.accountId
    )
      return c.json({ error: "authorization_required" }, 403);
    const stored = await secrets.put(
      serializeModelAccountSecret({ ...secret, apiProtocol: input.apiProtocol }, binding),
      {
        userId: signed.user.id,
        spaceId: owner.spaceId,
        operationId: "model-account",
        traceId: "model-account",
        signal: c.req.raw.signal,
      },
    );
    await prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: signed.user.id,
          spaceId: null,
          kind: "model",
          ciphertext: stored.ciphertext,
        },
      });
      const updated = await tx.userModelCredential.updateMany({
        where: { id: credential.id, userId: signed.user.id, secretId: row.id },
        data: { secretId: stored.id },
      });
      if (updated.count !== 1) throw new HTTPException(409, { message: "unavailable" });
      await deleteUnreferencedCredentialSecret(tx, {
        credentialKind: "model",
        credentialId: credential.id,
        secretId: row.id,
      });
    });
    return c.json({ apiProtocol: input.apiProtocol });
  });
  app.post("/models", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const owner = await actor(signed.user.id);
    const current = await identity(signed.user.id);
    const { apiKey } = await connection.provider.ensure(current, c.req.raw.signal);
    await save(owner, current, apiKey, undefined, true);
    return c.json({ connected: true });
  });
  // Reconcile only an existing uncertain exchange. Never start authorization or replay a code.
  app.post("/recover", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const current = await identity(signed.user.id);
    const pending = await prisma.modelOAuthSession.findFirst({
      where: { userId: signed.user.id, provider: "external-model", scope: signed.session.id },
      orderBy: { createdAt: "desc" },
    });
    if (!pending?.ciphertext) return c.json({ connected: false });
    const value = JSON.parse(await secrets.load(pending.ciphertext, pending.id)) as Transaction;
    if (
      value.phase !== "exchanging" ||
      value.accountId !== current.accountId ||
      value.binding !== current.binding ||
      value.credentialVersion !== connection.credentialVersion
    )
      return c.json({ error: "authorization_required" }, 403);
    const owner = await actor(signed.user.id, pending.spaceId);
    const { apiKey } = await connection.provider.ensure(current, c.req.raw.signal);
    await save(owner, current, apiKey, { id: pending.id, ciphertext: pending.ciphertext });
    return c.json({ connected: true });
  });
  app.post("/connect", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const owner = await actor(signed.user.id, c.req.header("x-rakazo-space-id"));
    const current = await identity(owner.userId);
    try {
      const { apiKey } = await connection.provider.ensure(current, c.req.raw.signal);
      await save(owner, current, apiKey);
      await prisma.modelOAuthSession.deleteMany({
        where: { userId: owner.userId, provider: "external-model", scope: signed.session.id },
      });
      return c.json({ connected: true });
    } catch (error) {
      if (
        !(error instanceof ExternalModelAccountError) ||
        error.reason !== "authorization_required"
      )
        throw error;
    }
    const body = (await c.req.json().catch(() => ({}))) as { callbackURL?: unknown };
    let returnTo: string | undefined;
    if (body.callbackURL !== undefined) {
      if (typeof body.callbackURL !== "string") return c.json({ error: "invalid_request" }, 400);
      let target: URL;
      try {
        target = new URL(body.callbackURL, deps.webOrigin);
      } catch {
        return c.json({ error: "invalid_request" }, 400);
      }
      if (
        target.origin !== new URL(deps.webOrigin).origin ||
        !(
          target.pathname === "/app" ||
          target.pathname.startsWith("/app/") ||
          target.pathname === "/onboarding" ||
          target.pathname === "/onboarding/model" ||
          target.pathname === "/sso/callback"
        )
      )
        return c.json({ error: "invalid_request" }, 400);
      if (
        target.pathname === "/sso/callback" &&
        (!validReturnPath(target.searchParams.get("returnTo"), deps.webOrigin) ||
          !/^[a-f0-9-]{36}$/.test(target.searchParams.get("nonce") ?? ""))
      )
        return c.json({ error: "invalid_request" }, 400);
      returnTo = target.href;
    }
    const ticket = random();
    const id = hash(ticket);
    const verifier = random();
    const value: Transaction = {
      sessionId: signed.session.id,
      accountId: current.accountId,
      binding: current.binding,
      verifier,
      browserProof: random(),
      launched: false,
      phase: "pending",
      native: c.req.header("origin") === "rakazo://",
      returnTo,
      credentialVersion: connection.credentialVersion,
    };
    const callback = new URL(CALLBACK, deps.authUrl).href;
    const authorization = await connection.provider.authorize(
      {
        identity: current,
        redirectUri: callback,
        state: id,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      },
      c.req.raw.signal,
    );
    const stored = await secrets.put(
      JSON.stringify({ ...value, url: authorization.url }),
      { ...owner, operationId: id, traceId: "model-account", signal: c.req.raw.signal },
      { recordId: id, ephemeral: true },
    );
    await prisma.modelOAuthSession.deleteMany({
      where: {
        userId: owner.userId,
        provider: "external-model",
        createdAt: { lt: new Date(Date.now() - TTL) },
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${signed.session.id} FOR UPDATE`,
      );
      await tx.modelOAuthSession.deleteMany({
        where: { userId: owner.userId, provider: "external-model", scope: signed.session.id },
      });
      await tx.modelOAuthSession.create({
        data: {
          id,
          userId: owner.userId,
          spaceId: owner.spaceId,
          provider: "external-model",
          scope: signed.session.id,
          ciphertext: stored.ciphertext,
        },
      });
    });
    const launch = new URL("/api/model-account/launch", deps.authUrl);
    launch.searchParams.set("ticket", ticket);
    return c.json({ connected: false, url: launch.href });
  });
  app.get("/launch", async (c) => {
    const ticket = c.req.query("ticket");
    if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || c.req.queries("ticket")?.length !== 1)
      return c.text("Invalid authorization", 400);
    const id = hash(ticket);
    const row = await prisma.modelOAuthSession.findFirst({
      where: { id, provider: "external-model", createdAt: { gt: new Date(Date.now() - TTL) } },
    });
    if (!row?.ciphertext) return c.text("Authorization expired", 400);
    const value = JSON.parse(await secrets.load(row.ciphertext, id)) as Transaction & {
      url: string;
    };
    if (value.launched || value.phase !== "pending") return c.text("Authorization expired", 400);
    const stored = await secrets.put(
      JSON.stringify({ ...value, launched: true }),
      {
        userId: row.userId,
        spaceId: row.spaceId,
        operationId: id,
        traceId: "model-account",
        signal: c.req.raw.signal,
      },
      { recordId: id, ephemeral: true },
    );
    const claimed = await prisma.modelOAuthSession.updateMany({
      where: { id, ciphertext: row.ciphertext },
      data: { ciphertext: stored.ciphertext },
    });
    if (claimed.count !== 1) return c.text("Authorization expired", 400);
    setCookie(c, cookieName(id), value.browserProof, {
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 300,
    });
    return c.redirect(value.url);
  });
  app.get("/callback", async (c) => {
    const id = c.req.query("state");
    const code = c.req.query("code");
    if (
      !connection ||
      !id ||
      !/^[a-f0-9]{64}$/.test(id) ||
      !code ||
      c.req.queries("state")?.length !== 1 ||
      c.req.queries("code")?.length !== 1
    )
      return c.text("Invalid authorization", 400);
    const row = await prisma.modelOAuthSession.findFirst({
      where: { id, provider: "external-model", createdAt: { gt: new Date(Date.now() - TTL) } },
    });
    if (!row?.ciphertext) return c.text("Authorization expired", 400);
    const value = JSON.parse(await secrets.load(row.ciphertext, id)) as Transaction;
    if (
      value.credentialVersion !== connection.credentialVersion ||
      !value.launched ||
      value.phase !== "pending" ||
      getCookie(c, cookieName(id)) !== value.browserProof
    )
      return c.text("Invalid authorization", 400);
    const original = await prisma.session.findUnique({ where: { id: value.sessionId } });
    const current = await identity(row.userId);
    if (
      !original ||
      original.userId !== row.userId ||
      original.expiresAt <= new Date() ||
      current.accountId !== value.accountId ||
      current.binding !== value.binding
    )
      return c.text("Authorization expired", 400);
    const owner = await actor(row.userId, row.spaceId);
    const exchanging = await secrets.put(
      JSON.stringify({ ...value, phase: "exchanging" }),
      {
        ...owner,
        operationId: id,
        traceId: "model-account",
        signal: c.req.raw.signal,
      },
      { recordId: id, ephemeral: true },
    );
    const claimed = await prisma.modelOAuthSession.updateMany({
      where: { id, ciphertext: row.ciphertext },
      data: { ciphertext: exchanging.ciphertext },
    });
    if (claimed.count !== 1) return c.text("Authorization expired", 400);
    deleteCookie(c, cookieName(id), { secure: true, path: "/" });
    let outcome: "authorization_required" | "result_unknown" | undefined;
    try {
      try {
        await connection.provider.complete(
          { code, codeVerifier: value.verifier },
          c.req.raw.signal,
        );
      } catch {
        // A lost exchange response is confirmed by ensure, never by replaying the code.
      }
      const { apiKey } = await connection.provider.ensure(current, c.req.raw.signal);
      await save(owner, current, apiKey, { id, ciphertext: exchanging.ciphertext });
    } catch (error) {
      outcome =
        error instanceof ExternalModelAccountError && error.reason === "authorization_required"
          ? "authorization_required"
          : "result_unknown";
    }
    const destination = new URL(
      value.native
        ? "rakazo://model-authorization"
        : (value.returnTo ?? new URL("/app", deps.webOrigin).href),
    );
    if (outcome)
      destination.searchParams.set(
        value.native || destination.pathname === "/sso/callback" ? "error" : "modelAccountError",
        outcome,
      );
    return c.redirect(destination.href);
  });
  app.post("/revoke", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    const current = await identity(signed.user.id);
    const revocationOwner = await actor(signed.user.id);
    const revocationId = hash(`revoke:${current.accountId}:${current.binding}`);
    const revocation = await secrets.put(
      JSON.stringify({ accountId: current.accountId, binding: current.binding }),
      {
        userId: signed.user.id,
        spaceId: revocationOwner.spaceId,
        operationId: revocationId,
        traceId: "model-account",
        signal: c.req.raw.signal,
      },
      { recordId: revocationId, ephemeral: true },
    );
    // New runs cannot use a connection while its revocation outcome is unknown.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "account" WHERE "id" = ${current.accountId} FOR UPDATE`,
      );
      const id = `external-${current.accountId}`;
      const previous = await tx.userModelCredential.findFirst({
        where: { id, userId: signed.user.id },
      });
      if (previous) {
        await tx.userModelCredential.delete({ where: { id } });
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: id,
          secretId: previous.secretId,
        });
      }
      await tx.modelOAuthSession.deleteMany({
        where: { userId: signed.user.id, provider: "external-model" },
      });
      await tx.modelOAuthSession.upsert({
        where: { id: revocationId },
        create: {
          id: revocationId,
          userId: signed.user.id,
          spaceId: revocationOwner.spaceId,
          provider: "external-model-revoke",
          scope: current.binding,
          ciphertext: revocation.ciphertext,
        },
        update: { ciphertext: revocation.ciphertext },
      });
    });
    try {
      await connection.provider.revoke(current, c.req.raw.signal);
    } catch {
      return c.json({ error: "result_unknown" }, 503);
    }
    await prisma.modelOAuthSession.deleteMany({
      where: { id: revocationId, ciphertext: revocation.ciphertext },
    });
    return c.json({ connected: false });
  });
  app.get("/balance", async (c) => {
    if (!connection) return c.json({ error: "disabled" }, 404);
    const signed = await session(c.req.raw);
    if (!signed) return c.json({ error: "login_required" }, 401);
    return c.json(
      await connection.provider.balance(await identity(signed.user.id), c.req.raw.signal),
    );
  });
  return app;
}

function validReturnPath(value: string | null, origin: string): boolean {
  if (!value) return false;
  try {
    const target = new URL(value, origin);
    return (
      target.origin === new URL(origin).origin &&
      !target.username &&
      !target.password &&
      (target.pathname === "/app" ||
        target.pathname.startsWith("/app/") ||
        target.pathname === "/onboarding" ||
        target.pathname === "/onboarding/model")
    );
  } catch {
    return false;
  }
}
