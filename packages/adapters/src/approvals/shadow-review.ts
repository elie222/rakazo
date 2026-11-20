import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
} from "@rakazo/adapter-kit";
import { humanizeToolName } from "@rakazo/core";
import { recordAuditEvent } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { reviewArgsTooLong } from "./auto-review.js";
import type { DecisionAutoReviewProvider, DecisionVerdict } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { DecisionModelDescriptor } from "./model-descriptor.js";

/**
 * The decision model a deployment is trialling beside `primary`, its included reviewer, for this
 * review. It must be another model of the same host on the same operator key, so its request goes
 * where the primary's does; `RAKAZO_AUTO_REVIEW_SHADOW_SAMPLE_RATE` (0 to 1, default 1) samples.
 */
export function autoReviewShadowModel(
  primary: DecisionModelDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  sample: () => number = Math.random,
): DecisionModelDescriptor | undefined {
  const id = env.RAKAZO_AUTO_REVIEW_SHADOW_MODEL?.trim();
  if (!id) return undefined;
  const shadow = decisionModel(primary.provider, id);
  if (!shadow || shadow === primary) return undefined;
  if (shadow.deploymentApiKey(env) !== primary.deploymentApiKey(env)) return undefined;
  return sample() < shadowSampleRate(env) ? shadow : undefined;
}

function shadowSampleRate(env: NodeJS.ProcessEnv): number {
  const raw = env.RAKAZO_AUTO_REVIEW_SHADOW_SAMPLE_RATE?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  // A rate that cannot be read runs no trial rather than trialling every review.
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

type TimedVerdict = DecisionVerdict & { latencyMs: number };

export interface ShadowedReview {
  request: AutoReviewRequest;
  /** The deciding reviewer's own verdict. */
  primary: TimedVerdict;
  shadow: TimedVerdict;
}

/**
 * Reviews with `primary` and, at the same time, with `shadow`. Only the primary's verdict is
 * returned, as soon as it has one; the shadow's is recorded beside it once both are in.
 */
export class ShadowedAutoReviewProvider implements AutoReviewProvider {
  constructor(
    private readonly options: {
      primary: DecisionAutoReviewProvider;
      shadow: DecisionAutoReviewProvider;
      record: (review: ShadowedReview) => Promise<void>;
    },
  ) {}
  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return this.options.primary.describe();
  }
  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    const { primary, shadow, record } = this.options;
    // A request too long to send is never judged, so there is nothing to compare.
    if (reviewArgsTooLong(request)) return primary.review(request, context);
    const decided = timed(() => primary.judge(request, context));
    const shadowed = timed(() => shadow.judge(request, context));
    void bestEffort(
      "auto_review.shadow",
      Promise.all([decided, shadowed]).then(([verdict, trial]) =>
        // A cancelled run records no review, so its shadow has nothing to sit beside.
        context.signal.aborted ? undefined : record({ request, primary: verdict, shadow: trial }),
      ),
    );
    return (await decided).result;
  }
}

async function timed(judge: () => Promise<DecisionVerdict>): Promise<TimedVerdict> {
  const started = performance.now();
  const verdict = await judge();
  return { ...verdict, latencyMs: Math.round(performance.now() - started) };
}

/** One audit event per shadowed review, joined to the action's own review by its effect id. */
export function recordShadowReview(
  scope: { spaceId: string; runId: string; threadId: string; effectId?: string },
  { request, primary, shadow }: ShadowedReview,
): Promise<void> {
  return recordAuditEvent({
    action: "approval.shadow_reviewed",
    actor: { type: "system", label: shadow.result.model },
    spaceId: scope.spaceId,
    target: { type: "tool", id: request.toolName, label: humanizeToolName(request.toolName) },
    outcome: shadow.result.decision === "error" ? "failure" : "success",
    runId: scope.runId,
    threadId: scope.threadId,
    metadata: {
      effectId: scope.effectId,
      decision: primary.result.decision,
      model: primary.result.model,
      passProbability: rounded(primary.passProbability),
      latencyMs: primary.latencyMs,
      shadowDecision: shadow.result.decision,
      // Why a trial failed: a key that cannot reach the model reads apart from a slow model.
      shadowReason: shadow.result.decision === "error" ? shadow.result.reason : undefined,
      shadowModel: shadow.result.model,
      shadowPassProbability: rounded(shadow.passProbability),
      shadowLatencyMs: shadow.latencyMs,
    },
  });
}

function rounded(probability: number | undefined): number | undefined {
  return probability === undefined ? undefined : Math.round(probability * 10_000) / 10_000;
}
