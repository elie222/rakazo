import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  CHATGPT_OAUTH_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
  type PiOAuthBegin,
  PiOAuthLogins,
  parseModelSecret,
  resolveModelApiKey,
  secretValuesToRedact,
  serializeModelSecret,
  XAI_OAUTH_PROVIDER,
} from "./pi-oauth.js";

const oauthCred = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct",
  ...overrides,
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

type TestActor = { userId: string; spaceId: string };

function deviceCodeResult(started: PiOAuthBegin) {
  if (started.mode !== "device-code") throw new Error("Expected a device-code login");
  return started;
}

function createControlledOAuthLogins() {
  let startedCount = 0;
  const resolvers = new Map<number, (credential: Credential) => void>();
  const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
    const index = startedCount++;
    interaction.notify({
      type: "device_code",
      userCode: `CODE-${index}`,
      verificationUri: "https://auth.openai.com/codex/device",
    });
    return new Promise<Credential>((resolve, reject) => {
      resolvers.set(index, resolve);
      interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  });
  return {
    logins,
    get startedCount() {
      return startedCount;
    },
    resolve(index: number, credential: Credential = oauthCred()) {
      const resolve = resolvers.get(index);
      if (!resolve) throw new Error(`No OAuth login ${index} is waiting for a credential.`);
      resolve(credential);
    },
  };
}

type ControlledOAuthLogins = ReturnType<typeof createControlledOAuthLogins>;

async function beginControlledOAuth(control: ControlledOAuthLogins, actor: TestActor, index = 0) {
  const started = await control.logins.begin({
    ...actor,
    provider: CHATGPT_OAUTH_PROVIDER,
  });
  control.resolve(index);
  await flushMicrotasks();
  return started;
}

describe("model secrets", () => {
  it("treats plaintext as an API key", () => {
    expect(parseModelSecret("sk-or-v1-abc")).toEqual({ kind: "api_key", key: "sk-or-v1-abc" });
  });

  it("round-trips OAuth credentials", () => {
    const credential = oauthCred({ expires: 42 });
    const parsed = parseModelSecret(serializeModelSecret({ kind: "oauth", credential }));
    expect(parsed).toEqual({ kind: "oauth", credential });
    expect(secretValuesToRedact(parsed)).toEqual(["access-token", "refresh-token"]);
  });

  it("round-trips openai-compatible credentials", () => {
    const parsed = parseModelSecret(
      serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
      }),
    );
    expect(parsed).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
  });

  it("refreshes expired OAuth tokens and persists them", async () => {
    const credential = oauthCred({ access: "old", expires: 1 });
    let saved = "";
    const apiKey = await resolveModelApiKey(JSON.stringify(credential), CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist: async (next) => {
        saved = next;
      },
      oauth: {
        refresh: async () => oauthCred({ access: "new", expires: 99_999 }),
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    expect(apiKey).toBe("new");
    expect(JSON.parse(saved).access).toBe("new");
  });
});

describe("PiOAuthLogins", () => {
  it("rejects providers without a subscription sign-in flow", async () => {
    const logins = new PiOAuthLogins();
    await expect(
      logins.begin({ userId: "u", spaceId: "w", provider: "openrouter" }),
    ).rejects.toThrow(/ChatGPT Plus\/Pro, Claude Pro\/Max, GitHub Copilot, and SuperGrok/);
  });

  it("runs the anthropic auth-url flow via submitted code", async () => {
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      const pasted = await interaction.prompt({
        type: "manual_code",
        message: "paste",
      });
      expect(pasted).toBe("pasted-code#state");
      return oauthCred({ access: "claude-access" });
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
    });
    expect(started.mode).toBe("auth-url");
    expect(started.verificationUri).toContain("claude.ai/oauth/authorize");
    expect("userCode" in started).toBe(false);

    expect(() =>
      logins.submit(started.loginId, { userId: "other", spaceId: "w" }, "pasted-code#state"),
    ).toThrow(/not found/);
    expect(() => logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "   ")).toThrow(
      /Paste an authorization code/,
    );

    expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "pasted-code#state"),
    ).toEqual({ ok: true });
    expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "pasted-code#state"),
    ).toEqual({ ok: true });

    await flushMicrotasks();
    const done = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(done.status).toBe("connected");
    if (done.status === "connected") expect(done.credential.access).toBe("claude-access");
  });

  it("rejects submit for a login that is not waiting for a code", async () => {
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "method",
        options: [{ id: "device_code", label: "Device" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.com/device",
        expiresInSeconds: 900,
      });
      return new Promise<Credential>(() => undefined);
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(() => logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "x")).toThrow(
      /not waiting for a pasted code/,
    );
    await logins.cancel(started.loginId, { userId: "u", spaceId: "w" });
  });

  it("releases a pending manual-code prompt when the login is cancelled", async () => {
    let promptSettled = false;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      try {
        await interaction.prompt({ type: "manual_code", message: "paste" });
      } finally {
        promptSettled = true;
      }
      return oauthCred();
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
    });

    await logins.cancel(started.loginId, { userId: "u", spaceId: "w" });
    await flushMicrotasks();

    expect(promptSettled).toBe(true);
  });

  it("honors provider cancellation of a manual-code prompt", async () => {
    const promptAbort = new AbortController();
    let promptSettled = false;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
      });
      try {
        await interaction.prompt({
          type: "manual_code",
          message: "paste",
          signal: promptAbort.signal,
        });
      } finally {
        promptSettled = true;
      }
      return oauthCred();
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
    });

    promptAbort.abort(new Error("Callback completed elsewhere"));
    await flushMicrotasks();

    expect(promptSettled).toBe(true);
    await logins.cancel(started.loginId, { userId: "u", spaceId: "w" });
  });

  it("rejects non-HTTPS authorization URLs", async () => {
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
      return oauthCred();
    });

    await expect(
      logins.begin({ userId: "u", spaceId: "w", provider: "anthropic" }),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("does not start a login for an already-aborted request", async () => {
    let started = false;
    const logins = new PiOAuthLogins(async () => {
      started = true;
      return oauthCred();
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      logins.begin({
        userId: "u",
        spaceId: "w",
        provider: CHATGPT_OAUTH_PROVIDER,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(started).toBe(false);
  });

  it("returns a device code after selecting device_code login", async () => {
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device" },
        ],
      });
      expect(method).toBe("device_code");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 900,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(deviceCodeResult(started).userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toContain("auth.openai.com");
    const pending = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(pending.status).toBe("pending");
    logins.abortAll();
  });

  it("returns the OAuth credential when login finishes", async () => {
    let finish!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "method",
        options: [{ id: "device_code", label: "Device" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "ZZZZ",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 60,
      });
      return new Promise<Credential>((resolve) => {
        finish = (credential) => resolve(credential);
      });
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
    });
    finish(oauthCred({ access: "live-access" }));
    await flushMicrotasks();
    const done = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(done).toMatchObject({
      status: "connected",
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
    });
    if (done.status === "connected") expect(done.credential.access).toBe("live-access");
    const persisted = await logins.finish(
      started.loginId,
      { userId: "u", spaceId: "w" },
      async (result) => result.credential.access,
    );
    expect(persisted).toEqual({ status: "connected", value: "live-access" });
    const gone = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(gone.status).toBe("error");
  });

  it("only lets the owning user and workspace cancel a login", async () => {
    let aborted = false;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "CANCEL",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });

    await logins.cancel(started.loginId, { userId: "other", spaceId: "workspace" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("pending");

    await logins.cancel(started.loginId, { userId: "owner", spaceId: "workspace" });
    expect(aborted).toBe(true);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("error");
  });

  it("orders cancellation behind an in-flight persistence claim", async () => {
    let finishLogin!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "COMMIT",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve) => {
        finishLogin = (credential) => resolve(credential);
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let persistenceStarted!: () => void;
    let persistenceSignal!: AbortSignal;
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const finishing = logins.finish(
      started.loginId,
      { userId: "owner", spaceId: "workspace" },
      async (result) => {
        persistenceSignal = result.signal;
        persistenceStarted();
        await persistence;
        return "saved";
      },
    );
    await startedPersistence;
    expect(persistenceSignal.aborted).toBe(false);

    await expect(
      logins.finish(started.loginId, { userId: "owner", spaceId: "workspace" }, async () => {
        throw new Error("duplicate persistence");
      }),
    ).resolves.toEqual({ status: "pending" });

    let cancellationFinished = false;
    const cancelling = logins
      .cancel(started.loginId, { userId: "owner", spaceId: "workspace" })
      .then(() => {
        cancellationFinished = true;
      });
    await Promise.resolve();
    expect(cancellationFinished).toBe(false);
    expect(persistenceSignal.aborted).toBe(false);

    releasePersistence();
    await expect(finishing).resolves.toEqual({ status: "connected", value: "saved" });
    await cancelling;
    expect(cancellationFinished).toBe(true);
    expect(persistenceSignal.aborted).toBe(false);
  });

  it("does not persist after cancellation wins before finalization", async () => {
    let finishLogin!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "CANCEL-FIRST",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve) => {
        finishLogin = resolve;
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    await logins.cancel(started.loginId, { userId: "owner", spaceId: "workspace" });
    let persisted = false;
    await expect(
      logins.finish(started.loginId, { userId: "owner", spaceId: "workspace" }, async () => {
        persisted = true;
        return "saved";
      }),
    ).resolves.toMatchObject({ status: "error" });
    expect(persisted).toBe(false);
  });

  it("allows a failed finalization to be retried", async () => {
    let finishLogin!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "RETRY",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve) => {
        finishLogin = resolve;
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    const failure = new Error("persistence failed");
    await expect(
      logins.finish(started.loginId, { userId: "owner", spaceId: "workspace" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("connected");

    await expect(
      logins.finish(
        started.loginId,
        { userId: "owner", spaceId: "workspace" },
        async (result) => result.credential.access,
      ),
    ).resolves.toEqual({ status: "connected", value: "access-token" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("error");
  });

  it("does not allow another actor to finish or persist a login", async () => {
    let finishLogin!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "OWNER-ONLY",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve) => {
        finishLogin = resolve;
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    let persisted = false;
    await expect(
      logins.finish(started.loginId, { userId: "other", spaceId: "workspace" }, async () => {
        persisted = true;
        return "saved";
      }),
    ).resolves.toMatchObject({ status: "error" });
    expect(persisted).toBe(false);
    await expect(
      logins.finish(started.loginId, { userId: "owner", spaceId: "other-workspace" }, async () => {
        persisted = true;
        return "saved";
      }),
    ).resolves.toMatchObject({ status: "error" });
    expect(persisted).toBe(false);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("connected");
  });

  it("waits for successful finalization before starting a replacement", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const original = await beginControlledOAuth(control, actor);

    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const finishing = control.logins.finish(original.loginId, actor, async () => {
      persistenceStarted();
      await persistence;
      return "saved";
    });
    await startedPersistence;

    const replacement = control.logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    releasePersistence();
    await expect(finishing).resolves.toEqual({ status: "connected", value: "saved" });
    await expect(replacement).resolves.toMatchObject({ userCode: "CODE-1" });
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, actor)).status).toBe("error");
    control.logins.abortAll();
  });

  it("starts a replacement after failed finalization returns to ready", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const original = await beginControlledOAuth(control, actor);

    let failPersistence!: (reason?: unknown) => void;
    let persistenceStarted!: () => void;
    const persistence = new Promise<void>((_, reject) => {
      failPersistence = reject;
    });
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const failure = new Error("persistence failed");
    const finishing = control.logins.finish(original.loginId, actor, async () => {
      persistenceStarted();
      await persistence;
      return "unreachable";
    });
    await startedPersistence;

    const replacement = control.logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    failPersistence(failure);
    await expect(finishing).rejects.toBe(failure);
    await expect(replacement).resolves.toMatchObject({ userCode: "CODE-1" });
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, actor)).status).toBe("error");
    control.logins.abortAll();
  });

  it("serializes concurrent replacements for one workspace scope", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const original = await beginControlledOAuth(control, actor);

    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const finishing = control.logins.finish(original.loginId, actor, async () => {
      persistenceStarted();
      await persistence;
      return "saved";
    });
    await startedPersistence;

    const replacementA = control.logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
    const replacementB = control.logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    releasePersistence();
    await finishing;
    const replacements = await Promise.allSettled([replacementA, replacementB]);
    expect(control.startedCount).toBe(3);
    const fulfilled = replacements.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const active: typeof fulfilled = [];
    for (const replacement of fulfilled) {
      if ((await control.logins.complete(replacement.loginId, actor)).status === "pending") {
        active.push(replacement);
      }
    }
    expect(active).toHaveLength(1);
    control.logins.abortAll();
  });

  it("does not start an aborted replacement after finalization wait", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const original = await beginControlledOAuth(control, actor);

    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const finishing = control.logins.finish(original.loginId, actor, async () => {
      persistenceStarted();
      await persistence;
      return "saved";
    });
    await startedPersistence;

    const request = new AbortController();
    const replacement = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      signal: request.signal,
    });
    await flushMicrotasks();
    request.abort(new Error("replacement cancelled"));
    releasePersistence();

    await finishing;
    await expect(replacement).rejects.toBeDefined();
    expect(control.startedCount).toBe(1);
    control.logins.abortAll();
  });

  it("keeps replacement scopes isolated by workspace", async () => {
    const ownerWorkspace = { userId: "owner", spaceId: "workspace-a" };
    const otherWorkspace = { userId: "owner", spaceId: "workspace-b" };
    const control = createControlledOAuthLogins();
    const original = await beginControlledOAuth(control, ownerWorkspace);

    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const startedPersistence = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const finishing = control.logins.finish(original.loginId, ownerWorkspace, async () => {
      persistenceStarted();
      await persistence;
      return "saved";
    });
    await startedPersistence;

    const otherWorkspaceLogin = await control.logins.begin({
      ...otherWorkspace,
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(deviceCodeResult(otherWorkspaceLogin).userCode).toBe("CODE-1");
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, ownerWorkspace)).status).toBe(
      "pending",
    );

    releasePersistence();
    await expect(finishing).resolves.toMatchObject({ status: "connected", value: "saved" });
    expect((await control.logins.complete(original.loginId, ownerWorkspace)).status).toBe("error");
    expect(
      (await control.logins.complete(otherWorkspaceLogin.loginId, otherWorkspace)).status,
    ).toBe("pending");
    control.logins.abortAll();
  });

  it("answers Copilot's enterprise prompt with github.com and returns a device code", async () => {
    const logins = new PiOAuthLogins(async (provider, _type, interaction) => {
      expect(provider).toBe(COPILOT_OAUTH_PROVIDER);
      const host = await interaction.prompt({
        type: "text",
        message: "GitHub Enterprise URL/domain (blank for github.com)",
      });
      expect(host).toBe("");
      interaction.notify({
        type: "device_code",
        userCode: "GH-CODE",
        verificationUri: "https://github.com/login/device",
        expiresInSeconds: 900,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: COPILOT_OAUTH_PROVIDER,
    });
    expect(deviceCodeResult(started).userCode).toBe("GH-CODE");
    expect(started.verificationUri).toContain("github.com");
    logins.abortAll();
  });

  it("returns an xAI device code with no login prompts", async () => {
    const logins = new PiOAuthLogins(async (provider, _type, interaction) => {
      expect(provider).toBe(XAI_OAUTH_PROVIDER);
      interaction.notify({
        type: "device_code",
        userCode: "XAI-CODE",
        verificationUri: "https://auth.x.ai/device",
        expiresInSeconds: 600,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: XAI_OAUTH_PROVIDER,
    });
    expect(deviceCodeResult(started).userCode).toBe("XAI-CODE");
    logins.abortAll();
  });
});
