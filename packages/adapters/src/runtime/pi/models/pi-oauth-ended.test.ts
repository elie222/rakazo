import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSignInError, PiOAuthLogins } from "./pi-oauth.js";
import type { PiOAuthEnded } from "./pi-oauth-ended.js";
import { pendingSignInOfRow, signInFailure, signInFailureText } from "./pi-oauth-ended.js";

const credential: OAuthCredential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
};
const member = { userId: "u", spaceId: "w" };
const measure = { surface: "web", attempt: 2 };

/** One process with a device-code provider the test answers or fails. */
function deviceCode(persist: () => Promise<string> = async () => "saved") {
  const answer = deferred<Credential>();
  const ended: PiOAuthEnded[] = [];
  const logins = new PiOAuthLogins<string>(
    async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "CODE",
        verificationUri: "https://auth.example.test/device",
        expiresInSeconds: 600,
      });
      return Promise.race([
        answer.promise,
        new Promise<Credential>((_resolve, reject) => {
          interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      ]);
    },
    undefined,
    (end) => ended.push(end),
  );
  const begin = (provider = "openai-codex") =>
    logins.begin({ ...member, provider, persist, measure });
  return { logins, begin, answer, ended };
}

describe("sign-ins that end without connecting", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a cancelled sign-in once, with what it carried", async () => {
    const { logins, begin, ended } = deviceCode();
    const started = await begin();

    expect(await logins.pendingSignIn(started.loginId, member)).toMatchObject({
      provider: "openai-codex",
      mode: "device-code",
      measure,
    });
    await logins.cancel(started.loginId, member);
    await logins.cancel(started.loginId, member);

    expect(ended).toEqual([
      {
        userId: "u",
        provider: "openai-codex",
        mode: "device-code",
        startedAt: expect.any(Date),
        measure,
        reason: "cancelled",
      },
    ]);
    expect(await logins.pendingSignIn(started.loginId, member)).toBeUndefined();
  });

  it("reports a sign-in nobody finished in time as timed out", async () => {
    vi.useFakeTimers();
    const { begin, ended } = deviceCode();
    await begin();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(ended.map((end) => end.reason)).toEqual(["timed_out"]);
  });

  it("reports the earlier sign-in as replaced when the person starts again", async () => {
    const { begin, ended } = deviceCode();
    await begin();
    await begin();

    expect(ended.map((end) => end.reason)).toEqual(["replaced"]);
  });

  it("reports the reason the app gave for stopping, and cancelled when it gave none", async () => {
    const { logins, begin, ended } = deviceCode();
    const left = await begin("openai-codex");
    await logins.cancel(left.loginId, member, "left");
    const replaced = await begin("github-copilot");
    await logins.cancel(replaced.loginId, member, "replaced");
    const older = await begin("xai");
    await logins.cancel(older.loginId, member);

    expect(ended.map((end) => [end.provider, end.reason])).toEqual([
      ["openai-codex", "left"],
      ["github-copilot", "replaced"],
      ["xai", "cancelled"],
    ]);
  });

  it("reports what the provider refused as a class, never its words", async () => {
    const { begin, answer, ended } = deviceCode();
    await begin();

    answer.reject(
      new Error("Provider authorization failed: access_denied for person@example.test"),
    );
    await vi.waitFor(() => expect(ended).toHaveLength(1));

    expect(ended[0]).toMatchObject({ reason: "provider_refused", errorClass: "denied" });
    expect(JSON.stringify(ended)).not.toContain("person@example.test");
  });

  it("reports a sign-in the provider accepted and the save refused", async () => {
    const { begin, answer, ended } = deviceCode(async () => {
      throw new ModelSignInError("This plan cannot add another connection.");
    });
    await begin();

    answer.resolve(credential);
    await vi.waitFor(() => expect(ended).toHaveLength(1));

    expect(ended[0]?.reason).toBe("save_failed");
  });

  it("stays silent for a sign-in that connected or never gave a link", async () => {
    const { logins, begin, answer, ended } = deviceCode();
    const started = await begin();
    answer.resolve(credential);
    await vi.waitFor(async () =>
      expect((await logins.complete(started.loginId, member)).status).toBe("connected"),
    );
    await logins.cancel(started.loginId, member);

    const refused = new PiOAuthLogins<string>(
      async () => {
        throw new Error("Device code request failed with status 503");
      },
      undefined,
      (end) => ended.push(end),
    );
    await expect(
      refused.begin({ ...member, provider: "openai-codex", persist: async () => "saved", measure }),
    ).rejects.toThrow();

    expect(ended).toEqual([]);
  });
});

describe("signInFailure", () => {
  it("reduces provider messages to a fixed reason and class", () => {
    expect(signInFailure("Device authorization expired.")).toEqual({ reason: "expired" });
    expect(signInFailure("Device flow timed out")).toEqual({ reason: "timed_out" });
    expect(signInFailure("OAuth state mismatch.")).toEqual({
      reason: "provider_refused",
      errorClass: "invalid_code",
    });
    expect(signInFailure("Token exchange failed (400). Start sign-in again.")).toEqual({
      reason: "provider_refused",
      errorClass: "rejected",
    });
    expect(signInFailure("OAuth token failed (HTTP 429)")).toMatchObject({
      errorClass: "rate_limited",
    });
    expect(signInFailure("token request failed with status 502")).toMatchObject({
      errorClass: "unavailable",
    });
    expect(signInFailure("Subscription sign-in failed.")).toMatchObject({ errorClass: "other" });
  });
});

describe("pendingSignInOfRow", () => {
  const row = {
    userId: "u",
    provider: "anthropic",
    ciphertext: "sealed",
    surface: "ios",
    connectNumber: 3,
    createdAt: new Date(0),
  };

  it("reads the flow and the measured try from a stored sign-in", () => {
    expect(pendingSignInOfRow(row)).toEqual({
      userId: "u",
      provider: "anthropic",
      mode: "auth-url",
      startedAt: new Date(0),
      measure: { surface: "ios", attempt: 3 },
    });
    expect(
      pendingSignInOfRow({ ...row, ciphertext: null, surface: null, connectNumber: null }),
    ).toEqual({ userId: "u", provider: "anthropic", mode: "device-code", startedAt: new Date(0) });
  });
});

describe("signInFailureText", () => {
  it.each([
    [
      "Device sign-in poll failed (status 400, access_denied).",
      "Sign-in was declined. Start again.",
    ],
    [
      "Device sign-in poll failed (status 503).",
      "Sign-in is unavailable right now. Try again in a minute.",
    ],
    [
      "Device sign-in poll could not reach the provider.",
      "Sign-in is unavailable right now. Try again in a minute.",
    ],
    ["The provider said the device code expired", "This code expired. Start again."],
    ["Token request timed out", "Sign-in failed. Start again."],
    [
      "Device sign-in token exchange failed (status 400, request_failed).",
      "Sign-in is unavailable right now. Try again in a minute.",
    ],
  ])("shows fixed text for %s", (message, text) => {
    expect(signInFailureText(signInFailure(message))).toBe(text);
  });
});
