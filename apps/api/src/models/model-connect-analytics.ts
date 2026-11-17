import type { ProductAnalytics } from "@rakazo/adapter-kit";
import type { PiOAuthEnded, PiOAuthMeasure, PiOAuthPending } from "@rakazo/adapters";
import { listPiCatalog } from "@rakazo/adapters";
import type {
  Actor,
  AnalyticsErrorKind,
  AnalyticsModelConnectMethod,
  AnalyticsModelSignInFlow,
  AnalyticsModelSignInStep,
} from "@rakazo/contracts";
import {
  AnalyticsSurface,
  canonicalPiProviderId,
  MODEL_KEY_REJECTED_ERROR,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { normalizeRunError } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "../router.js";
import { modelSetup } from "../routes/shared.js";

type ConnectMethod = Exclude<AnalyticsModelConnectMethod, "compatible">;

type ModelConnectOutcome =
  | { name: "model_connect_started" }
  | { name: "model_connected"; flow?: AnalyticsModelSignInFlow; durationMs?: number }
  | { name: "model_connect_failed"; error: unknown };

/** Where a try began and which of the person's tries it is. */
type ModelConnectTry = { surface?: AnalyticsSurface; attempt?: number };

type ModelConnectRecorder = (provider: string | undefined, outcome: ModelConnectOutcome) => void;

/** Whether the member has no model chat can run; undefined when that could not be read. */
async function needsFirstModel(deps: RouterDeps, actor: Actor): Promise<boolean | undefined> {
  // Measurement must never fail a connection.
  return (await bestEffort("model connect measurement", modelSetup(deps, actor)))?.needsModel;
}

function recorder(
  analytics: ProductAnalytics,
  userId: string,
  method: ConnectMethod,
  attempted: ModelConnectTry,
): ModelConnectRecorder {
  return (provider, outcome) => {
    const properties = { ...modelConnectProperties(provider, method), ...attempted };
    if (outcome.name === "model_connect_failed") {
      const errorKind = modelConnectErrorKind(outcome.error);
      analytics.capture(userId, { name: outcome.name, ...properties, errorKind });
    } else analytics.capture(userId, { ...outcome, ...properties });
  };
}

/**
 * Records the outcome of a sign-in that was measured when it began. It stays measured to
 * its end, whatever else its person connects meanwhile; one that was not is never recorded.
 */
export function signInRecorder(
  analytics: ProductAnalytics | undefined,
  userId: string,
  measure: PiOAuthMeasure | undefined,
): ModelConnectRecorder {
  if (!analytics || !measure) return () => {};
  return recorder(analytics, userId, "oauth", signInTry(measure));
}

/**
 * Measures the "Connect a model" step: only while the user has no model chat can run, so
 * later settings edits stay out of the funnel. Begins a measured try: numbers it for the
 * person and records that it started. `measure` is what a sign-in carries so its later
 * steps are reported; absent when the try is not measured.
 */
export async function startModelConnect(
  deps: RouterDeps,
  actor: Actor,
  method: ConnectMethod,
  provider: string | undefined,
  surface: AnalyticsSurface | undefined,
): Promise<{ record: ModelConnectRecorder; measure?: PiOAuthMeasure }> {
  const analytics = deps.analytics;
  if (!analytics || !(await needsFirstModel(deps, actor))) return { record: () => {} };
  const counted = await bestEffort(
    "model connect try number",
    deps.prisma.user.update({
      where: { id: actor.userId },
      // A newer try replaces a credits choice still waiting for its purchase.
      data: { modelConnectStarts: { increment: 1 }, pendingCreditsConnect: null },
      select: { modelConnectStarts: true },
    }),
  );
  // A try that could not be numbered is left out whole, so none starts without an outcome.
  if (!counted) return { record: () => {} };
  const attempt = counted.modelConnectStarts;
  const tried = { ...(surface ? { surface } : {}), attempt };
  const record = recorder(analytics, actor.userId, method, tried);
  record(provider, { name: "model_connect_started" });
  return { record, measure: tried };
}

/**
 * Choosing credits connects at once when the account already holds some. Otherwise the
 * try waits for the purchase that funds it, which billing reports when it lands.
 */
export async function recordCreditsChoice(
  deps: RouterDeps,
  actor: Actor,
  started: Awaited<ReturnType<typeof startModelConnect>>,
): Promise<void> {
  if (!started.measure) return;
  const needsModel = await needsFirstModel(deps, actor);
  if (needsModel === false) started.record(undefined, { name: "model_connected" });
  if (needsModel !== true) return;
  await bestEffort(
    "credits choice awaiting its purchase",
    deps.prisma.user.updateMany({
      where: { id: actor.userId, modelConnectStarts: started.measure.attempt },
      data: { pendingCreditsConnect: started.measure.attempt },
    }),
  );
}

/** Only fixed catalog ids leave the server; compatible endpoints never send their address. */
export function modelConnectProperties(
  provider: string | undefined,
  method: ConnectMethod,
): { method: AnalyticsModelConnectMethod; provider?: string } {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return { method: "compatible" };
  const canonical = provider && canonicalPiProviderId(provider);
  return canonical && listPiCatalog().some((entry) => entry.provider === canonical)
    ? { method, provider: canonical }
    : { method };
}

export function modelConnectErrorKind(error: unknown): AnalyticsErrorKind {
  const message = error instanceof Error ? error.message : "";
  if (message === MODEL_KEY_REJECTED_ERROR) return "auth";
  return normalizeRunError(message).kind ?? "other";
}

/** What a measured sign-in's try carries on every event. */
export function signInTry(measure: PiOAuthMeasure | undefined): ModelConnectTry {
  const surface = AnalyticsSurface.safeParse(measure?.surface);
  return {
    ...(surface.success ? { surface: surface.data } : {}),
    ...(measure ? { attempt: measure.attempt } : {}),
  };
}

export function signInFlow(mode: PiOAuthPending["mode"]): AnalyticsModelSignInFlow {
  return mode === "device-code" ? "device_code" : "paste_code";
}

export function signInDurationMs(startedAt: Date): number {
  return Math.max(0, Date.now() - startedAt.getTime());
}

/**
 * Reports a step of a subscription sign-in. Only a sign-in that began while its person
 * still needed a model is measured; it stays measured to its end, whatever else they
 * connect meanwhile.
 */
export function recordSignInStep(
  analytics: ProductAnalytics | undefined,
  signIn: PiOAuthPending,
  step: "code_issued" | AnalyticsModelSignInStep,
): void {
  if (!analytics || !signIn.measure) return;
  const properties = signInProperties(signIn);
  analytics.capture(
    signIn.userId,
    step === "code_issued"
      ? { name: "model_connect_code_issued", ...properties }
      : step === "page_opened"
        ? { name: "model_connect_page_opened", ...properties }
        : { name: "model_connect_code_copied", ...properties },
  );
}

/** Reports a sign-in that gave the person a link or code and did not connect. */
export function recordSignInEnded(
  analytics: ProductAnalytics | undefined,
  ended: PiOAuthEnded,
): void {
  if (!analytics || !ended.measure) return;
  analytics.capture(ended.userId, {
    name: "model_connect_ended",
    ...signInProperties(ended),
    reason: ended.reason,
    ...(ended.errorClass ? { errorClass: ended.errorClass } : {}),
    durationMs: signInDurationMs(ended.startedAt),
  });
}

function signInProperties(signIn: PiOAuthPending) {
  return {
    ...modelConnectProperties(signIn.provider, "oauth"),
    ...signInTry(signIn.measure),
    flow: signInFlow(signIn.mode),
  };
}
