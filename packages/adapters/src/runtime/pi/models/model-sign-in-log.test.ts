import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { deferred } from "@rakazo/core/test-async";
import type { Logger, TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_OAUTH_PROVIDER, PiOAuthLogins } from "./pi-oauth.js";

const actor = { userId: "fake-member", spaceId: "fake-space" };
const credential: OAuthCredential = {
  type: "oauth",
  access: "fake-access-secret",
  refresh: "fake-refresh-secret",
  expires: 9_999_999_999_999,
};

describe("model sign-in lifecycle logs", () => {
  let sink: TestSink;
  let previousLogger: Logger;
  const sessions: PiOAuthLogins<string>[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    previousLogger = getLogger();
    sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.abortAll()));
    installLogger(previousLogger);
    vi.useRealTimers();
  });

  function deviceSignIn(expiresInSeconds = 60) {
    const exchange = deferred<Credential>();
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "fake-device-secret",
        verificationUri: "https://auth.example.test/?code=fake-url-secret",
        expiresInSeconds,
      });
      return exchange.promise;
    });
    sessions.push(logins);
    return { logins, exchange };
  }

  const begin = (logins: PiOAuthLogins<string>) =>
    logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      label: "fake-private-label",
      measure: { attempt: 3, surface: "android" },
      persist: async () => "fake-saved-connection",
    });

  function lifecycle() {
    return sink.events.filter((event) => event.message === "model sign-in lifecycle");
  }

  it("correlates provider authorization and saving even when the app never reads the result", async () => {
    const { logins, exchange } = deviceSignIn();
    const started = await begin(logins);
    exchange.resolve(credential);
    await vi.waitFor(() =>
      expect(lifecycle().map((event) => event["model.sign_in.stage"])).toContain("connected"),
    );
    expect(lifecycle().map((event) => event["model.sign_in.stage"])).toEqual([
      "started",
      "authorization_ready",
      "authorized",
      "saving",
      "connected",
    ]);
    for (const event of lifecycle()) {
      expect(event).toMatchObject({
        "model.sign_in.id": started.loginId,
        "model.sign_in.provider": CHATGPT_OAUTH_PROVIDER,
        "model.sign_in.surface": "android",
        "model.sign_in.attempt": 3,
        "model.sign_in.elapsed_ms": expect.any(Number),
      });
    }
    const serialized = JSON.stringify(sink.events);
    for (const privateValue of [
      ...Object.values(actor),
      credential.access,
      credential.refresh,
      "fake-device-secret",
      "fake-url-secret",
      "fake-private-label",
      "fake-saved-connection",
      "auth.example.test",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("logs expiry once without an analytics callback or any status reads", async () => {
    const { logins } = deviceSignIn(1);
    const started = await begin(logins);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lifecycle().filter((event) => event["model.sign_in.stage"] === "ended")).toEqual([
      expect.objectContaining({
        "model.sign_in.id": started.loginId,
        "model.sign_in.reason": "timed_out",
        "model.sign_in.elapsed_ms": 1_000,
      }),
    ]);
    await logins.cancel(started.loginId, actor);
    expect(lifecycle().filter((event) => event["model.sign_in.stage"] === "ended")).toHaveLength(1);
  });

  it("classifies a local start deadline as a timeout", async () => {
    const exchange = deferred<Credential>();
    const logins = new PiOAuthLogins<string>(() => exchange.promise);
    sessions.push(logins);
    const result = expect(begin(logins)).rejects.toThrow("Subscription sign-in did not start");
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(lifecycle()).toContainEqual(
      expect.objectContaining({
        "model.sign_in.stage": "start_failed",
        "model.sign_in.reason": "timed_out",
      }),
    );
  });

  it("logs interruption for an in-memory sign-in on shutdown", async () => {
    const { logins } = deviceSignIn();
    const started = await begin(logins);
    await logins.abortAll();
    expect(lifecycle().at(-1)).toMatchObject({
      "model.sign_in.id": started.loginId,
      "model.sign_in.stage": "interrupted",
    });
  });

  it("distinguishes a replacement from an explicit cancellation", async () => {
    const { logins } = deviceSignIn();
    const first = await begin(logins);
    const second = await begin(logins);
    await logins.cancel(second.loginId, actor);
    expect(lifecycle().filter((event) => event["model.sign_in.stage"] === "replaced")).toEqual([
      expect.objectContaining({ "model.sign_in.id": first.loginId }),
    ]);
    expect(
      lifecycle()
        .filter((event) => event["model.sign_in.stage"] === "ended")
        .map((event) => event["model.sign_in.id"]),
    ).toEqual([first.loginId, second.loginId]);
  });

  it("reports a provider refusal as a fixed class without copying its response", async () => {
    const { logins, exchange } = deviceSignIn();
    await begin(logins);
    exchange.reject(new Error("access_denied: fake-private-response"));
    await vi.waitFor(() =>
      expect(lifecycle()).toContainEqual(
        expect.objectContaining({
          "model.sign_in.stage": "ended",
          "model.sign_in.reason": "provider_refused",
          "model.sign_in.error_class": "denied",
        }),
      ),
    );
    expect(JSON.stringify(sink.events)).not.toContain("fake-private-response");
  });

  it("records pasted-code submission separately from the provider exchange", async () => {
    const codeReceived = deferred<string>();
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.test/",
        instructions: "open",
      });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
      codeReceived.resolve(code);
      return credential;
    });
    sessions.push(logins);
    const started = await begin(logins);
    await logins.submit(started.loginId, actor, "fake-pasted-secret", async () => "saved");
    expect(await codeReceived.promise).toBe("fake-pasted-secret");
    await vi.waitFor(() =>
      expect(lifecycle().map((event) => event["model.sign_in.stage"])).toContain("connected"),
    );
    const stages = lifecycle().map((event) => event["model.sign_in.stage"]);
    expect(stages.indexOf("code_submitted")).toBeLessThan(stages.indexOf("authorized"));
    expect(JSON.stringify(sink.events)).not.toContain("fake-pasted-secret");
  });
});
