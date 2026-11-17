import type { PiOAuthPending } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  AnalyticsEvent,
  MODEL_KEY_REJECTED_ERROR,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import {
  firstModelConnectAnalytics,
  modelConnectErrorKind,
  modelConnectProperties,
  recordCreditsUsable,
  recordSignInEnded,
  recordSignInStep,
  startModelConnect,
} from "./model-connect-analytics.js";

const modelSetup = vi.hoisted(() => vi.fn());
vi.mock("../routes/shared.js", () => ({ modelSetup }));

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

describe("model connect analytics", () => {
  beforeEach(() => modelSetup.mockReset());

  it("sends catalog provider ids and never a compatible endpoint or unknown provider", () => {
    expect(modelConnectProperties("openai", "api_key")).toEqual({
      method: "api_key",
      provider: "openai",
    });
    expect(modelConnectProperties(OPENAI_COMPATIBLE_PROVIDER_ID, "api_key")).toEqual({
      method: "compatible",
    });
    expect(modelConnectProperties("https://private.example.test", "api_key")).toEqual({
      method: "api_key",
    });
    expect(modelConnectProperties(undefined, "oauth")).toEqual({ method: "oauth" });
  });

  it("reduces failures to a coarse kind", () => {
    expect(modelConnectErrorKind(new Error(MODEL_KEY_REJECTED_ERROR))).toBe("auth");
    expect(modelConnectErrorKind(new Error('429: {"error":{"message":"rate limit"}}'))).toBe(
      "rate",
    );
    expect(modelConnectErrorKind(new Error("Could not verify the API key. Try again."))).toBe(
      "other",
    );
    expect(modelConnectErrorKind("not an error")).toBe("other");
  });

  it("records only while the user has no usable model", async () => {
    const capture = vi.fn();
    const deps = { analytics: { capture, flush: async () => undefined } } as unknown as RouterDeps;

    modelSetup.mockResolvedValueOnce({ needsModel: false });
    (await firstModelConnectAnalytics(deps, actor, "api_key"))("openai", {
      name: "model_connected",
    });
    expect(capture).not.toHaveBeenCalled();

    modelSetup.mockRejectedValueOnce(new Error("db unavailable"));
    (await firstModelConnectAnalytics(deps, actor, "api_key"))("openai", {
      name: "model_connected",
    });
    expect(capture).not.toHaveBeenCalled();

    modelSetup.mockResolvedValueOnce({ needsModel: true });
    const record = await firstModelConnectAnalytics(deps, actor, "api_key");
    record("openai", { name: "model_connect_started" });
    record("openai", {
      name: "model_connect_failed",
      error: new Error(`${MODEL_KEY_REJECTED_ERROR} sk-private`),
    });
    expect(capture.mock.calls).toEqual([
      ["user-1", { name: "model_connect_started", method: "api_key", provider: "openai" }],
      [
        "user-1",
        { name: "model_connect_failed", method: "api_key", provider: "openai", errorKind: "other" },
      ],
    ]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("sk-private");
  });

  function measuredDeps(starts = 0) {
    const capture = vi.fn();
    let count = starts;
    const update = vi.fn(async () => ({ modelConnectStarts: ++count }));
    const deps = {
      analytics: { capture, flush: async () => undefined },
      prisma: { user: { update } },
    } as unknown as RouterDeps;
    return { deps, capture, update };
  }

  it("numbers each try and carries the app on its events", async () => {
    const { deps, capture } = measuredDeps(1);
    modelSetup.mockResolvedValue({ needsModel: true });

    const started = await startModelConnect(deps, actor, "api_key", "openai", "desktop");
    started.record("openai", { name: "model_connected" });

    expect(started.measure).toEqual({ surface: "desktop", attempt: 2 });
    const tried = { method: "api_key", provider: "openai", surface: "desktop", attempt: 2 };
    expect(capture.mock.calls).toEqual([
      ["user-1", { name: "model_connect_started", ...tried }],
      ["user-1", { name: "model_connected", ...tried }],
    ]);
  });

  it("neither counts nor measures a try by someone who already has a model", async () => {
    const { deps, capture, update } = measuredDeps();
    modelSetup.mockResolvedValue({ needsModel: false });

    const started = await startModelConnect(deps, actor, "oauth", "openai-codex", "web");
    started.record("openai-codex", { name: "model_connected" });

    expect(started.measure).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("shows the outcome of choosing credits only once they can run a model", async () => {
    const { deps, capture } = measuredDeps();
    modelSetup.mockResolvedValue({ needsModel: true });
    const started = await startModelConnect(deps, actor, "credits", undefined, "ios");

    await recordCreditsUsable(deps, actor, started);
    expect(capture).toHaveBeenCalledTimes(1);

    modelSetup.mockResolvedValue({ needsModel: false });
    await recordCreditsUsable(deps, actor, started);
    expect(capture.mock.calls[1]).toEqual([
      "user-1",
      { name: "model_connected", method: "credits", surface: "ios", attempt: 1 },
    ]);
  });

  const signIn: PiOAuthPending = {
    userId: "user-1",
    provider: "openai-codex",
    mode: "device-code",
    startedAt: new Date(Date.now() - 5_000),
    measure: { surface: "android", attempt: 3 },
  };

  it("reports sign-in steps and endings with fixed fields the contract accepts", () => {
    const capture = vi.fn();
    const analytics = { capture, flush: async () => undefined };

    recordSignInStep(analytics, signIn, "code_issued");
    recordSignInStep(analytics, { ...signIn, mode: "auth-url" }, "page_opened");
    recordSignInStep(analytics, signIn, "code_copied");
    recordSignInEnded(analytics, {
      ...signIn,
      reason: "provider_refused",
      errorClass: "denied",
    });

    const tried = { method: "oauth", provider: "openai-codex", surface: "android", attempt: 3 };
    expect(capture.mock.calls.map(([, event]) => event)).toEqual([
      { name: "model_connect_code_issued", ...tried, flow: "device_code" },
      { name: "model_connect_page_opened", ...tried, flow: "paste_code" },
      { name: "model_connect_code_copied", ...tried, flow: "device_code" },
      {
        name: "model_connect_ended",
        ...tried,
        flow: "device_code",
        reason: "provider_refused",
        errorClass: "denied",
        durationMs: expect.any(Number),
      },
    ]);
    for (const [, event] of capture.mock.calls) {
      expect(AnalyticsEvent.safeParse(event).success).toBe(true);
    }
    expect(capture.mock.calls[3]?.[1].durationMs).toBeGreaterThanOrEqual(5_000);
  });

  it("leaves out a sign-in that is not measured, an unknown app and an unknown provider", () => {
    const capture = vi.fn();
    const analytics = { capture, flush: async () => undefined };

    recordSignInStep(analytics, { ...signIn, measure: undefined }, "code_issued");
    recordSignInEnded(analytics, { ...signIn, measure: undefined, reason: "cancelled" });
    expect(capture).not.toHaveBeenCalled();

    recordSignInEnded(analytics, {
      ...signIn,
      provider: "https://private.example.test",
      measure: { surface: "kiosk", attempt: 1 },
      reason: "timed_out",
    });
    expect(capture.mock.calls[0]?.[1]).toEqual({
      name: "model_connect_ended",
      method: "oauth",
      attempt: 1,
      flow: "device_code",
      reason: "timed_out",
      durationMs: expect.any(Number),
    });
  });
});
