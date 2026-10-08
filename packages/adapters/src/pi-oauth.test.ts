import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelCredentialFailedState, ModelCredentialRetireReason } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_OAUTH_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
  isRetiredModelCredentialError,
  kickModelCredentialRefresh,
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  oauthCredentialAccountId,
  type PiOAuthBegin,
  PiOAuthLogins,
  parseModelSecret,
  RetiredModelCredentialError,
  refreshExpiredModelCredential,
  resolveModelApiKey,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
  terminalOAuthRefreshErrorMarker,
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

// Unsigned fake JWT: base64url JSON payload, no real token material.
const fakeJwt = (payload: unknown) =>
  `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake`;

const chatGptAccountClaim = (accountId: string) => ({
  "https://api.openai.com/auth": { chatgpt_account_id: accountId },
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
  it("round-trips generic limits without changing legacy API-key storage or redaction", () => {
    expect(serializeModelSecret({ kind: "api_key", key: "fake-api-key" })).toBe("fake-api-key");
    const secret = {
      kind: "api_key" as const,
      key: "fake-api-key",
      contextWindow: 1000000,
      maxTokens: 4096,
    };
    const decoded = parseModelSecret(serializeModelSecret(secret));
    expect(decoded).toEqual(secret);
    expect(secretValuesToRedact(decoded)).toEqual(["fake-api-key"]);
  });
  it("round-trips compatible model limits", () => {
    const secret = {
      kind: "openai_compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 8192,
      maxTokens: 1024,
    };
    expect(parseModelSecret(serializeModelSecret(secret))).toEqual(secret);
  });
  it("treats plaintext as an API key", () => {
    expect(parseModelSecret("sk-or-v1-abc")).toEqual({ kind: "api_key", key: "sk-or-v1-abc" });
  });

  it("round-trips an API key output limit", () => {
    const parsed = parseModelSecret(
      serializeModelSecret({ kind: "api_key", key: "sk-test-key", maxTokens: 8192 }),
    );
    expect(parsed).toEqual({ kind: "api_key", key: "sk-test-key", maxTokens: 8192 });
    expect(secretValuesToRedact(parsed)).toEqual(["sk-test-key"]);
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

  it("rejects credential JSON that declares a kind but misses its fields", () => {
    expect(() => parseModelSecret(JSON.stringify({ kind: "oauth" }))).toThrow(/corrupt/);
    expect(() =>
      parseModelSecret(JSON.stringify({ kind: "oauth", credential: { type: "oauth" } })),
    ).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "api_key" }))).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "api_key", key: "" }))).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "openai_compatible" }))).toThrow(
      /corrupt/,
    );
  });

  it("rejects a broken legacy OAuth credential object", () => {
    expect(() =>
      parseModelSecret(JSON.stringify({ type: "oauth", access: "access-token" })),
    ).toThrow(/corrupt/);
  });

  it("keeps JSON without a recognized credential kind as a literal API key", () => {
    const unknownKind = JSON.stringify({ kind: "bearer", token: "abc" });
    expect(parseModelSecret(unknownKind)).toEqual({ kind: "api_key", key: unknownKind });
    const objectKey = JSON.stringify({ hello: "world" });
    expect(parseModelSecret(objectKey)).toEqual({ kind: "api_key", key: objectKey });
    expect(parseModelSecret("{broken-json")).toEqual({ kind: "api_key", key: "{broken-json" });
  });

  it("fails a corrupt stored credential instead of using it as an API key", async () => {
    const corrupt = JSON.stringify({ kind: "oauth", credential: { type: "oauth" } });
    await expect(resolveModelApiKey(corrupt, CHATGPT_OAUTH_PROVIDER)).rejects.toThrow(/corrupt/);
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

  it("keeps a configured output limit when refreshing OAuth tokens", async () => {
    const stored = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({ access: "old", expires: 1 }),
      maxTokens: 16384,
    });
    let saved = "";
    const resolved = await resolveModelAuth(stored, CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist: async (next) => {
        saved = next;
      },
      oauth: {
        refresh: async () => oauthCred({ access: "new", expires: 99_999 }),
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    expect(resolved.apiKey).toBe("new");
    expect(resolved.secret.maxTokens).toBe(16384);
    expect(parseModelSecret(saved)).toMatchObject({
      kind: "oauth",
      maxTokens: 16384,
      credential: expect.objectContaining({ access: "new" }),
    });
  });
});

describe("terminalOAuthRefreshErrorMarker", () => {
  it.each([
    "invalid_grant",
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
  ])("matches the terminal marker %s in a pi-wrapped refresh error", (marker) => {
    const providerError = new Error(
      `OpenAI Codex token refresh failed (400): {"error":"${marker}","error_description":"gone"}`,
    );
    const wrapped = new Error("OAuth refresh failed for openai-codex", { cause: providerError });
    expect(terminalOAuthRefreshErrorMarker(wrapped)).toBe(marker);
  });

  it.each([400, 401, 403])("matches a marker alongside a %i status", (status) => {
    const providerError = new Error(
      `OpenAI Codex token refresh failed (${status}): {"error":"invalid_grant"}`,
    );
    expect(terminalOAuthRefreshErrorMarker(providerError)).toBe("invalid_grant");
  });

  it("matches pi's Kimi Coding unauthorized marker", () => {
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error("Kimi Code token refresh unauthorized (status 401)"),
      ),
    ).toBe("Kimi Code token refresh unauthorized");
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error("Kimi Code token refresh unauthorized (status 403): token revoked"),
      ),
    ).toBe("Kimi Code token refresh unauthorized");
  });

  it("matches a marker embedded in the outer message", () => {
    expect(
      terminalOAuthRefreshErrorMarker(new Error('token refresh failed (400): "invalid_grant"')),
    ).toBe("invalid_grant");
  });

  it("accepts a marker and a terminal status split across the cause chain", () => {
    const wrapped = new Error("OAuth refresh failed for xai", {
      cause: new Error('{"error":"invalid_grant"}', {
        cause: new Error("xAI OAuth token refresh failed (HTTP 403)"),
      }),
    });
    expect(terminalOAuthRefreshErrorMarker(wrapped)).toBe("invalid_grant");
  });

  it.each(['"upstream 503"', '"status 502"', '"(502)"', '"upstream status=502"'])(
    "still retires a real 400 whose body text mentions %s",
    (quoted) => {
      // The quoted status lives inside the embedded response body, so it is not
      // the layer's own status and must not veto the genuine terminal 400.
      const body = JSON.stringify({ error: "invalid_grant", error_description: quoted });
      expect(
        terminalOAuthRefreshErrorMarker(
          new Error(`OpenAI Codex token refresh failed (400): ${body}`),
        ),
      ).toBe("invalid_grant");
    },
  );

  it("retires an Anthropic terminal error whose body field mentions a 5xx", () => {
    // Anthropic flattens nested errors into `details=...; status=400; ...
    // body={...}`; the 503 sits inside the quoted body field, not the layer's
    // own status.
    const anthropic = new Error(
      "Anthropic token refresh request failed. url=https://api.anthropic.com; " +
        "details=Error: HTTP request failed. status=400; url=https://api.anthropic.com; " +
        'body={"error":"invalid_grant","error_description":"upstream status=503"}',
    );
    expect(terminalOAuthRefreshErrorMarker(anthropic)).toBe("invalid_grant");
  });

  it("retires a Copilot-style terminal error whose body text mentions a 5xx", () => {
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error(
          '400 Bad Request: {"error":"invalid_grant","error_description":"upstream (502)"}',
        ),
      ),
    ).toBe("invalid_grant");
  });

  it.each([
    [
      "4xx marker outer, 5xx inner",
      new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}', {
        cause: new Error("gateway upstream failed (502)"),
      }),
    ],
    [
      "5xx outer, 4xx marker inner",
      new Error("OAuth refresh failed for openai-codex (503)", {
        cause: new Error('{"error":"invalid_grant"}', {
          cause: new Error("token endpoint rejected (400)"),
        }),
      }),
    ],
    [
      "kimi unauthorized marker with a 5xx layer",
      new Error("Kimi Code token refresh unauthorized (status 403)", {
        cause: new Error("proxy hop failed with status 504"),
      }),
    ],
  ])("does not classify a %s chain as terminal", (_label, error) => {
    // A 5xx anywhere in the chain vetoes a terminal 4xx + marker elsewhere —
    // the deeper gateway failure means the token endpoint never judged the
    // credential.
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();
  });

  it.each([
    [
      "5xx body quoting a marker",
      new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
    ],
    [
      "502 body quoting a marker",
      new Error(
        'OpenAI Codex token refresh failed (502): {"error":"invalid_grant","error_description":"gateway"}',
      ),
    ],
    ["marker without a status", new Error('{"error":"invalid_grant"}')],
    [
      "marker on a 200 body missing fields",
      new Error('OpenAI Codex token refresh response missing fields: {"error":"invalid_grant"}'),
    ],
    [
      "marker with a non-terminal 4xx",
      new Error('OpenAI Codex token refresh failed (404): {"error":"invalid_grant"}'),
    ],
    [
      "marker with an unrelated number",
      new Error("token refresh failed: invalid_grant (retry after 400 ms)"),
    ],
    ["thrown marker string", "refresh_token_reused"],
    ["network failure", new Error("OpenAI Codex token refresh error: fetch failed")],
    ["server error", new Error("OpenAI Codex token refresh failed (503): service unavailable")],
    [
      "kimi retryable status",
      new Error('Kimi Code token refresh failed with status 500: {"error":"invalid_grant"}'),
    ],
    ["timeout", new Error("The operation timed out")],
    ["malformed body", new Error("OpenAI Codex token refresh response missing fields: {}")],
    ["lookalike identifier", new Error('{"error":"not_invalid_grant"} (400)')],
    ["marker prefix only", new Error('{"error":"invalid_granted"} (400)')],
    ["non-error object", { message: "invalid_grant (400)" }],
    ["null", null],
    ["undefined", undefined],
  ])("does not classify a %s as terminal", (_label, error) => {
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();
  });

  it("stops walking after the chain depth limit", () => {
    let error: Error = new Error('(400) {"error":"invalid_grant"}');
    for (let i = 0; i < 12; i += 1) error = new Error(`layer ${i}`, { cause: error });
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();

    let shallow: Error = new Error('(400) {"error":"invalid_grant"}');
    for (let i = 0; i < 3; i += 1) shallow = new Error(`layer ${i}`, { cause: shallow });
    expect(terminalOAuthRefreshErrorMarker(shallow)).toBe("invalid_grant");
  });
});

describe("resolveModelAuth retirement", () => {
  const expired = JSON.stringify(oauthCred({ access: "old", expires: 1 }));

  const failingRefresh = (error: unknown) => ({
    refresh: async (): Promise<OAuthCredential> => {
      throw error;
    },
    toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
  });

  it("retires once with the classified marker, then rethrows the refresh error", async () => {
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});

    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        persist,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "invalid_grant",
      // The stored credential state the failed refresh was attempted on.
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    expect(persist).not.toHaveBeenCalled();
    expect(isRetiredModelCredentialError(failure)).toBe(true);
  });

  it("does not retire on transient refresh failures", async () => {
    for (const failure of [
      new Error("OpenAI Codex token refresh error: fetch failed"),
      new Error("OpenAI Codex token refresh failed (500): {"),
      new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
      new Error("request timed out"),
    ]) {
      const retire = vi.fn(async () => undefined);
      await expect(
        resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
          now: 10_000,
          retire,
          oauth: failingRefresh(failure),
        }),
      ).rejects.toBe(failure);
      expect(retire).not.toHaveBeenCalled();
      expect(isRetiredModelCredentialError(failure)).toBe(false);
    }
  });

  it("rethrows the refresh error when retirement itself fails", async () => {
    const failure = new Error('refresh failed (400): {"error":"refresh_token_expired"}');
    const retireFailure = new Error("database gone");
    const retire = vi.fn(async () => {
      throw retireFailure;
    });

    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "refresh_token_expired",
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    expect(isRetiredModelCredentialError(failure)).toBe(false);
  });

  it("does not mark a refresh error retired when the delete was skipped", async () => {
    const failure = new Error('refresh failed (400): {"error":"invalid_grant"}');
    const retire = vi.fn(async () => false);
    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
    expect(isRetiredModelCredentialError(failure)).toBe(false);
  });

  it("rethrows the refresh error when no retire hook is configured", async () => {
    const failure = new Error('refresh failed (400): {"error":"invalid_grant"}');
    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
  });

  it("does not refresh or retire while the stored token is still valid", async () => {
    const refresh = vi.fn();
    const retire = vi.fn(async () => undefined);
    const resolved = await resolveModelAuth(
      JSON.stringify(oauthCred({ access: "live", expires: 1_000_000 })),
      CHATGPT_OAUTH_PROVIDER,
      {
        now: 10_000,
        retire,
        oauth: {
          refresh,
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      },
    );
    expect(resolved.apiKey).toBe("live");
    expect(refresh).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
});

describe("resolveModelAuth account-change guard", () => {
  const expiredAccount = (accountId: string | undefined, access = "old") =>
    JSON.stringify(oauthCred({ access, expires: 1, accountId }));

  const succeedingRefresh = (next: OAuthCredential) => ({
    refresh: async (): Promise<OAuthCredential> => next,
    toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
  });

  // Wire the retire hook the way the executor does around
  // retireModelCredential: the failed credential state becomes a
  // matchesFailedOAuthSecret predicate over the secret row's current
  // ciphertext, and the delete only runs while the row still matches. Without
  // the failed state there is no fence and the delete proceeds.
  const fencingRetire =
    (row: () => string, deleteCredential: () => void) =>
    async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => row(), failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };

  it("persists a refresh that returns the same account", async () => {
    const retire = vi.fn(async () => undefined);
    const persist = vi.fn(async () => {});
    const resolved = await resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist,
      retire,
      oauth: succeedingRefresh(oauthCred({ access: "new", expires: 99_999, accountId: "acct-a" })),
    });
    expect(resolved.apiKey).toBe("new");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires the credential and fails when the refresh returns a different account", async () => {
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});
    const toAuth = vi.fn(
      async (current: OAuthCredential): Promise<{ apiKey: string }> => ({
        apiKey: current.access,
      }),
    );

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        persist,
        retire,
        oauth: {
          refresh: async () => oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
          toAuth,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    // The account-B token is never persisted or used.
    expect(persist).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it("detects the account change from the refreshed token's JWT claim", async () => {
    const retire = vi.fn(async () => true);
    // A refresh that does not copy `accountId` onto the credential is still
    // caught when the new access token carries the ChatGPT account claim.
    const refresh = async (): Promise<OAuthCredential> =>
      oauthCred({
        access: fakeJwt(chatGptAccountClaim("acct-b")),
        expires: 99_999,
        accountId: undefined,
      });

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: {
          refresh,
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      }),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("compares against a stored account id carried only by the stored access JWT", async () => {
    const retire = vi.fn(async () => true);
    await expect(
      resolveModelAuth(
        expiredAccount(undefined, fakeJwt(chatGptAccountClaim("acct-a"))),
        CHATGPT_OAUTH_PROVIDER,
        {
          now: 10_000,
          retire,
          oauth: succeedingRefresh(
            oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
          ),
        },
      ),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("still fails with the readable error when account-change retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: succeedingRefresh(
          oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("skips the account-change delete when a concurrent refresh rotated the secret row", async () => {
    // A sibling run refreshed the ORIGINAL account and rewrote the same secret
    // row while this refresh was in flight; the stale account-change failure
    // must not delete the newer credential.
    const stored = oauthCred({ access: "old", expires: 1, accountId: "acct-a" });
    let row = serializeModelSecret({ kind: "oauth", credential: stored });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: {
          refresh: async () => {
            row = serializeModelSecret({
              kind: "oauth",
              credential: oauthCred({
                access: "rotated",
                refresh: "rotated-refresh",
                expires: 50_000,
                accountId: "acct-a",
              }),
            });
            return oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" });
          },
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("still deletes while the secret row matches the failed account-change state", async () => {
    // The fence must not block the intended delete: the row still holds the
    // credential that produced the foreign account, so it goes away.
    const stored = oauthCred({ access: "old", expires: 1, accountId: "acct-a" });
    const row = serializeModelSecret({ kind: "oauth", credential: stored });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: succeedingRefresh(
          oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stored side", undefined, "acct-b"],
    ["refreshed side", "acct-a", undefined],
    ["both sides", undefined, undefined],
  ])(
    "tolerates a missing account id on the %s",
    async (_case, storedAccountId, refreshedAccountId) => {
      const retire = vi.fn(async () => undefined);
      const persist = vi.fn(async () => {});
      const resolved = await resolveModelAuth(
        expiredAccount(storedAccountId),
        CHATGPT_OAUTH_PROVIDER,
        {
          now: 10_000,
          persist,
          retire,
          oauth: succeedingRefresh(
            oauthCred({ access: "new", expires: 99_999, accountId: refreshedAccountId }),
          ),
        },
      );
      expect(resolved.apiKey).toBe("new");
      expect(persist).toHaveBeenCalledTimes(1);
      expect(retire).not.toHaveBeenCalled();
    },
  );

  it("skips the account-change delete when another worker rotated only the access token", async () => {
    // A successful refresh can keep the same refresh token and expiry and
    // rewrite only the access token. The fence has to notice that too.
    const stored = oauthCred({
      access: "old",
      refresh: "same-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const row = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({
        access: "rotated-access",
        refresh: "same-refresh",
        expires: 1,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: succeedingRefresh(
          oauthCred({ access: "foreign", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });
});

describe("oauthCredentialAccountId", () => {
  it("reads the namespaced chatgpt_account_id claim", () => {
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            ...chatGptAccountClaim("acct-ns"),
            chatgpt_account_id: "acct-top",
          }),
        }),
      ),
    ).toBe("acct-ns");
  });

  it("falls back to a top-level chatgpt_account_id claim", () => {
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: "",
          access: fakeJwt({ chatgpt_account_id: "acct-top" }),
        }),
      ),
    ).toBe("acct-top");
  });

  it("falls back to the top-level claim when the namespaced one is blank", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(
        oauthCredentialAccountId(
          oauthCred({
            accountId: undefined,
            access: fakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: blank },
              chatgpt_account_id: "acct-top",
            }),
          }),
        ),
      ).toBe("acct-top");
    }
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "" },
            chatgpt_account_id: "   ",
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back to the top-level claim when the namespaced one is not a string", () => {
    for (const namespaced of [42, false, { id: "acct-obj" }, null]) {
      expect(
        oauthCredentialAccountId(
          oauthCred({
            accountId: undefined,
            access: fakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: namespaced },
              chatgpt_account_id: "acct-top",
            }),
          }),
        ),
      ).toBe("acct-top");
    }
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: 42 },
            chatgpt_account_id: 7,
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps a padded accountId and skips one that is only whitespace", () => {
    const access = fakeJwt(chatGptAccountClaim("acct-jwt"));
    expect(oauthCredentialAccountId(oauthCred({ accountId: "  acct-direct  ", access }))).toBe(
      "  acct-direct  ",
    );
    expect(oauthCredentialAccountId(oauthCred({ accountId: "   ", access }))).toBe("acct-jwt");
  });

  it("returns undefined for an undecodable token", () => {
    expect(
      oauthCredentialAccountId(oauthCred({ accountId: undefined, access: "not-a-jwt" })),
    ).toBeUndefined();
    expect(() =>
      oauthCredentialAccountId(oauthCred({ accountId: " \t ", access: "a.!!!.c" })),
    ).not.toThrow();
    expect(
      oauthCredentialAccountId(oauthCred({ accountId: " \t ", access: "a.!!!.c" })),
    ).toBeUndefined();
  });
});

describe("matchesFailedOAuthSecret", () => {
  const failed = { access: "old-access", refresh: "old-refresh", expires: 1 };
  const load = (ciphertext: string) => ciphertext;
  const predicate = () => matchesFailedOAuthSecret(load, failed);
  const row = (credential: OAuthCredential) => ({
    id: "secret-1",
    ciphertext: serializeModelSecret({ kind: "oauth", credential }),
  });

  it("matches only when the stored credential is still the one that failed", async () => {
    expect(await predicate()(row(oauthCred(failed)))).toBe(true);
  });

  it("skips a secret another worker refreshed in place", async () => {
    // A successful refresh can rotate only the access token and keep the same
    // refresh token and expiry. Any of the three fields changing means the
    // stored row is no longer the failed attempt.
    expect(
      await predicate()(
        row(oauthCred({ access: "new-access", refresh: "old-refresh", expires: 1 })),
      ),
    ).toBe(false);
    expect(
      await predicate()(
        row(oauthCred({ access: "old-access", refresh: "new-refresh", expires: 1 })),
      ),
    ).toBe(false);
    expect(
      await predicate()(
        row(oauthCred({ access: "old-access", refresh: "old-refresh", expires: 2 })),
      ),
    ).toBe(false);
  });

  it("skips material it cannot prove is the failed credential", async () => {
    expect(await predicate()({ id: "secret-1", ciphertext: "not-json" })).toBe(false);
    expect(
      await predicate()({
        id: "secret-1",
        ciphertext: serializeModelSecret({ kind: "api_key", key: "sk-test" }),
      }),
    ).toBe(false);
    const broken = matchesFailedOAuthSecret(() => {
      throw new Error("decrypt failed");
    }, failed);
    expect(await broken({ id: "secret-1", ciphertext: "cipher" })).toBe(false);
  });
});

describe("refreshExpiredModelCredential", () => {
  const scope = { userId: "user-1", spaceId: "ws-1" };

  function secretRow(initial: string) {
    let current = initial;
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })),
        update: vi.fn(async () => ({})),
      },
    } as unknown as PrismaClient;
    const secretStore = {
      load: vi.fn(async () => current),
      put: vi.fn(async (next: string) => {
        current = next;
        return {
          id: "secret-1",
          ref: `cipher:${next.length}`,
          ciphertext: `cipher:${next.length}`,
        };
      }),
    };
    return {
      prisma,
      secretStore,
      update: prisma.secret.update as unknown as ReturnType<typeof vi.fn>,
    };
  }

  const stubOAuth = (refresh: (credential: OAuthCredential) => Promise<OAuthCredential>) => ({
    refresh: vi.fn(refresh),
    toAuth: vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access })),
  });

  it("refreshes and persists an expired OAuth credential", async () => {
    const { prisma, secretStore, update } = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "old", expires: 1 }),
      }),
    );
    const oauth = stubOAuth(async () =>
      oauthCred({ access: "new", expires: Date.now() + 3_600_000 }),
    );

    await refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );

    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "secret-1" },
      data: { ciphertext: expect.any(String) },
    });

    // The stored credential is now fresh, so a queued second run is a no-op.
    await refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
  });

  it("leaves a still-valid bearer and non-OAuth secrets untouched", async () => {
    const fresh = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "kept", expires: Date.now() + 3_600_000 }),
      }),
    );
    const oauth = stubOAuth(async () => oauthCred({ access: "new" }));
    await refreshExpiredModelCredential(
      fresh.prisma,
      fresh.secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(fresh.secretStore.put).not.toHaveBeenCalled();

    const apiKey = secretRow("sk-test-plain-key");
    await refreshExpiredModelCredential(
      apiKey.prisma,
      apiKey.secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(apiKey.secretStore.put).not.toHaveBeenCalled();
  });

  it("serializes on the credential lock so concurrent kicks refresh once", async () => {
    const { prisma, secretStore } = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "old", expires: 1 }),
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const oauth = stubOAuth(async () => {
      await gate;
      return oauthCred({ access: "new", expires: Date.now() + 3_600_000 });
    });

    const first = refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    const second = refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    // The second call waited on the lock, then saw the already-fresh token.
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
  });
});

describe("kickModelCredentialRefresh", () => {
  const scope = { userId: "user-1", spaceId: "ws-1" };

  it("collapses concurrent kicks into one refresh and frees the slot after", async () => {
    let current = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({ access: "old", expires: 1 }),
    });
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })),
        update: vi.fn(async () => ({})),
      },
    } as unknown as PrismaClient;
    const secretStore = {
      load: vi.fn(async () => current),
      put: vi.fn(async (next: string) => {
        current = next;
        return { id: "secret-1", ref: "next", ciphertext: "next" };
      }),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const oauth = {
      refresh: vi.fn(async () => {
        await gate;
        return oauthCred({ access: "new", expires: Date.now() + 3_600_000 });
      }),
      toAuth: vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access })),
    };
    const opts = { oauth };

    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(secretStore.put).toHaveBeenCalledTimes(1));
    expect(oauth.refresh).toHaveBeenCalledTimes(1);

    // Let the kick's finally settle so the in-flight slot frees before re-kicking.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Once the kick settles a later expired read may kick again — this one
    // finds the fresh token and refreshes nothing.
    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    await vi.waitFor(() => expect(oauth.toAuth).toHaveBeenCalledTimes(2));
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
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
    // The persist signal is the session's own — cancel never aborted the
    // in-flight write; teardown aborts it only after the write settled.
    expect(persistenceSignal.aborted).toBe(true);
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

  describe("session timers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("still expires a session that is not finalizing", async () => {
      vi.useFakeTimers();
      const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "EXPIRE",
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 60,
        });
        return oauthCred();
      });
      const actor = { userId: "u", spaceId: "w" };
      const started = await logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
      await flushMicrotasks();

      vi.advanceTimersByTime(61_000);
      expect((await logins.complete(started.loginId, actor)).status).toBe("error");
    });

    it("keeps a finalizing session when expiry elapses so a replacement cannot overwrite it", async () => {
      vi.useFakeTimers();
      const actor = { userId: "u", spaceId: "w" };
      let startedCount = 0;
      const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
        startedCount += 1;
        interaction.notify({
          type: "device_code",
          userCode: `CODE-${startedCount}`,
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 60,
        });
        return oauthCred({ access: `access-${startedCount}` });
      });
      const started = await logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
      await flushMicrotasks();

      let releasePersist!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePersist = resolve;
      });
      let persistedAccess: string | undefined;
      const finishing = logins.finish(started.loginId, actor, async (result) => {
        await gate;
        // The expiry timer must not abort this write. A replacement that
        // started underneath it would be overwritten by this persist.
        if (result.signal.aborted) throw result.signal.reason;
        persistedAccess = result.credential.access;
        return "saved-original";
      });
      await Promise.resolve();

      vi.advanceTimersByTime(61_000);
      expect((await logins.complete(started.loginId, actor)).status).toBe("pending");

      const replacement = logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
      await flushMicrotasks();
      expect(startedCount).toBe(1);

      releasePersist();
      await expect(finishing).resolves.toEqual({ status: "connected", value: "saved-original" });
      expect(persistedAccess).toBe("access-1");
      await expect(replacement).resolves.toMatchObject({ userCode: "CODE-2" });
      expect(startedCount).toBe(2);
      logins.abortAll();
    });

    it("drops a session whose save fails after expiry instead of restoring it", async () => {
      vi.useFakeTimers();
      const actor = { userId: "u", spaceId: "w" };
      let startedCount = 0;
      const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
        startedCount += 1;
        interaction.notify({
          type: "device_code",
          userCode: `CODE-${startedCount}`,
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 60,
        });
        return oauthCred();
      });
      const started = await logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
      await flushMicrotasks();

      let releasePersist!: (error?: unknown) => void;
      const gate = new Promise<void>((resolve, reject) => {
        releasePersist = (error) => (error ? reject(error) : resolve());
      });
      const failure = new Error("persistence failed");
      const finishing = logins.finish(started.loginId, actor, async () => {
        await gate;
        return "saved";
      });
      await Promise.resolve();

      vi.advanceTimersByTime(61_000);
      expect((await logins.complete(started.loginId, actor)).status).toBe("pending");

      releasePersist(failure);
      await expect(finishing).rejects.toBe(failure);
      expect((await logins.complete(started.loginId, actor)).status).toBe("error");

      const replacement = await logins.begin({ ...actor, provider: CHATGPT_OAUTH_PROVIDER });
      expect(deviceCodeResult(replacement).userCode).toBe("CODE-2");
      expect(startedCount).toBe(2);
      logins.abortAll();
    });

    it("clears armed expiry timers when abortAll runs", async () => {
      vi.useFakeTimers();
      const control = createControlledOAuthLogins();
      await control.logins.begin({
        userId: "u",
        spaceId: "w",
        provider: CHATGPT_OAUTH_PROVIDER,
      });
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);

      control.logins.abortAll();
      expect(vi.getTimerCount()).toBe(armed - 1);
    });
  });
});
