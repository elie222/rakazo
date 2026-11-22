import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
  DecisionProvider,
} from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import {
  autoReviewMinConfidence,
  autoReviewTimeoutMs,
  reviewArgsTooLong,
  sanitizeAutoReviewReason,
  TOO_LONG_TO_REVIEW,
} from "./auto-review.js";
import {
  autoReviewDecisionQuestion,
  reviewTaskMaxChars,
  truncateReviewText,
} from "./auto-review.prompt.js";
import { passConfidenceFloor } from "./decision-models.js";
import type { DecisionCalibration } from "./model-descriptor.js";

const MAX_BOT_CHARS = 240;
export const APPROVAL_DECISION_RUBRIC_VERSION = "approval-v11";
export class DecisionAutoReviewProvider implements AutoReviewProvider {
  constructor(
    private readonly options: {
      provider: DecisionProvider;
      providerId: string;
      model: string;
      calibration: DecisionCalibration;
      /** The operator's floor on the model's own confidence, instead of its calibration. */
      minConfidence?: number;
      timeoutMs?: number;
    },
  ) {}
  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: this.options.providerId,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, keyless: false },
    };
  }
  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    const modelLabel = `${this.options.providerId}/${this.options.model}`;
    if (reviewArgsTooLong(request)) {
      return { decision: "ask", model: modelLabel, reason: TOO_LONG_TO_REVIEW };
    }
    try {
      const result = await this.options.provider.decide(
        {
          model: this.options.model,
          state: {
            rubricVersion: APPROVAL_DECISION_RUBRIC_VERSION,
            toolName: request.toolName,
            connectorKind: request.connectorKind,
            args: request.args,
            userTask: truncateReviewText(request.userTask, reviewTaskMaxChars(request)),
            botDescription: truncateReviewText(request.botDescription, MAX_BOT_CHARS),
            matchingRules: request.matchingRules.map((rule) => ({
              effect: rule.effect,
              matchKind: rule.matchKind,
              matchValue: rule.matchValue,
            })),
            ...(request.newSite ? { newSite: true } : {}),
            ...(request.savedContextWrite ? { savedContextWrite: true } : {}),
            ...(request.ownComputerAction ? { ownComputerAction: true } : {}),
            ...(request.ownerMessages?.length
              ? { ownerEarlierMessages: request.ownerMessages }
              : {}),
            ...(request.outsideOnlyTargets?.length
              ? { outsideOnlyTargets: request.outsideOnlyTargets }
              : {}),
          },
          questions: { decision: autoReviewDecisionQuestion(request) },
        },
        {
          ...context,
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(this.options.timeoutMs ?? autoReviewTimeoutMs()),
          ]),
        },
      );
      const answer = result.answers.decision;
      const model = `${this.options.providerId}/${result.model}`;
      if (answer?.choice === "ask") return { decision: "ask", model };
      if (answer?.choice !== "pass")
        return { decision: "error", model, reason: "Checker returned no decision." };
      if (
        typeof answer.confidence !== "number" ||
        answer.confidence <
          (this.options.minConfidence ??
            autoReviewMinConfidence() ??
            passConfidenceFloor(this.options.calibration))
      )
        // An unsure checker asks like any other ask: a reason saying so tells the person nothing.
        return { decision: "ask", model };
      return { decision: "pass", model };
    } catch (error) {
      const reason =
        error instanceof DecisionProviderError
          ? {
              authentication: "Checker could not authenticate.",
              invalid_response: "Checker returned no decision.",
              invalid: "Checker request was invalid.",
              busy: "Checker is busy.",
              unavailable: "Checker timed out or failed.",
            }[error.kind]
          : "Checker returned no decision.";
      return { decision: "error", model: modelLabel, reason: sanitizeAutoReviewReason(reason) };
    }
  }
}
