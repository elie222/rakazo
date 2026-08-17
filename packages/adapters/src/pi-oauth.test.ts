import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  CHATGPT_OAUTH_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
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
  it("rejects providers without a device-code flow", async () => {
    const logins = new PiOAuthLogins();
    await expect(
      logins.begin({ userId: "u", workspaceId: "w", provider: "anthropic" }),
    ).rejects.toThrow(/ChatGPT Plus\/Pro, GitHub Copilot, and SuperGrok/);
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
        workspaceId: "w",
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
      workspaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toContain("auth.openai.com");
    const pending = await logins.complete(started.loginId, { userId: "u", workspaceId: "w" });
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
      workspaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
    });
    finish(oauthCred({ access: "live-access" }));
    await flushMicrotasks();
    const done = await logins.complete(started.loginId, { userId: "u", workspaceId: "w" });
    expect(done).toMatchObject({
      status: "connected",
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
    });
    if (done.status === "connected") expect(done.credential.access).toBe("live-access");
    const persisted = await logins.finish(
      started.loginId,
      { userId: "u", workspaceId: "w" },
      async (result) => result.credential.access,
    );
    expect(persisted).toEqual({ status: "connected", value: "live-access" });
    const gone = await logins.complete(started.loginId, { userId: "u", workspaceId: "w" });
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
      workspaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });

    await logins.cancel(started.loginId, { userId: "other", workspaceId: "workspace" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" }))
        .status,
    ).toBe("pending");

    await logins.cancel(started.loginId, { userId: "owner", workspaceId: "workspace" });
    expect(aborted).toBe(true);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" }))
        .status,
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
      workspaceId: "workspace",
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
      { userId: "owner", workspaceId: "workspace" },
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
      logins.finish(
        started.loginId,
        { userId: "owner", workspaceId: "workspace" },
        async () => {
          throw new Error("duplicate persistence");
        },
      ),
    ).resolves.toEqual({ status: "pending" });

    let cancellationFinished = false;
    const cancelling = logins
      .cancel(started.loginId, { userId: "owner", workspaceId: "workspace" })
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
      workspaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    await logins.cancel(started.loginId, { userId: "owner", workspaceId: "workspace" });
    let persisted = false;
    await expect(
      logins.finish(
        started.loginId,
        { userId: "owner", workspaceId: "workspace" },
        async () => {
          persisted = true;
          return "saved";
        },
      ),
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
      workspaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    const failure = new Error("persistence failed");
    await expect(
      logins.finish(
        started.loginId,
        { userId: "owner", workspaceId: "workspace" },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" }))
        .status,
    ).toBe("connected");

    await expect(
      logins.finish(
        started.loginId,
        { userId: "owner", workspaceId: "workspace" },
        async (result) => result.credential.access,
      ),
    ).resolves.toEqual({ status: "connected", value: "access-token" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" })).status,
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
      workspaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    finishLogin(oauthCred());
    await flushMicrotasks();

    let persisted = false;
    await expect(
      logins.finish(
        started.loginId,
        { userId: "other", workspaceId: "workspace" },
        async () => {
          persisted = true;
          return "saved";
        },
      ),
    ).resolves.toMatchObject({ status: "error" });
    expect(persisted).toBe(false);
    await expect(
      logins.finish(
        started.loginId,
        { userId: "owner", workspaceId: "other-workspace" },
        async () => {
          persisted = true;
          return "saved";
        },
      ),
    ).resolves.toMatchObject({ status: "error" });
    expect(persisted).toBe(false);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" })).status,
    ).toBe("connected");
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
      workspaceId: "w",
      provider: COPILOT_OAUTH_PROVIDER,
    });
    expect(started.userCode).toBe("GH-CODE");
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
      workspaceId: "w",
      provider: XAI_OAUTH_PROVIDER,
    });
    expect(started.userCode).toBe("XAI-CODE");
    logins.abortAll();
  });
});
