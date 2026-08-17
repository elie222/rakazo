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
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = await logins.complete(started.loginId, { userId: "u", workspaceId: "w" });
    expect(done).toMatchObject({
      status: "connected",
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
    });
    if (done.status === "connected") expect(done.credential.access).toBe("live-access");
    logins.consume(started.loginId);
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

    logins.cancel(started.loginId, { userId: "other", workspaceId: "workspace" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" }))
        .status,
    ).toBe("pending");

    logins.cancel(started.loginId, { userId: "owner", workspaceId: "workspace" });
    expect(aborted).toBe(true);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", workspaceId: "workspace" }))
        .status,
    ).toBe("error");
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
