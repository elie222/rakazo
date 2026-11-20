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
  MAX_OWNER_WORDS_CHARS,
  truncateReviewText,
} from "./auto-review.prompt.js";
import { passConfidenceFloor, passProbability } from "./decision-models.js";
import type { DecisionCalibration } from "./model-descriptor.js";

const MAX_TASK_CHARS = 400;
const MAX_BOT_CHARS = 240;
export const APPROVAL_DECISION_RUBRIC_VERSION = "approval-v8";

/** A decision model's verdict and, when it answered, its probability that the action may pass. */
export interface DecisionVerdict {
  result: AutoReviewResult;
  passProbability?: number;
}
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
    return (await this.judge(request, context)).result;
  }
  /** The verdict, with the model's probability that the action may pass when it answered. */
  async judge(request: AutoReviewRequest, context: AdapterContext): Promise<DecisionVerdict> {
    const modelLabel = `${this.options.providerId}/${this.options.model}`;
    if (reviewArgsTooLong(request)) {
      return { result: { decision: "ask", model: modelLabel, reason: TOO_LONG_TO_REVIEW } };
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
            userTask: truncateReviewText(
              request.userTask,
              request.newSite || request.savedContextWrite ? MAX_OWNER_WORDS_CHARS : MAX_TASK_CHARS,
            ),
            botDescription: truncateReviewText(request.botDescription, MAX_BOT_CHARS),
            matchingRules: request.matchingRules.map((rule) => ({
              effect: rule.effect,
              matchKind: rule.matchKind,
              matchValue: rule.matchValue,
            })),
            ...(request.newSite ? { newSite: true } : {}),
            ...(request.savedContextWrite ? { savedContextWrite: true } : {}),
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
      const probability =
        (answer?.choice === "pass" || answer?.choice === "ask") &&
        typeof answer.confidence === "number"
          ? {
              passProbability: passProbability(
                this.options.calibration,
                answer.choice,
                answer.confidence,
              ),
            }
          : {};
      if (answer?.choice === "ask") return { result: { decision: "ask", model }, ...probability };
      if (answer?.choice !== "pass")
        return { result: { decision: "error", model, reason: "Checker returned no decision." } };
      if (
        typeof answer.confidence !== "number" ||
        answer.confidence <
          (this.options.minConfidence ??
            autoReviewMinConfidence() ??
            passConfidenceFloor(this.options.calibration))
      )
        // An unsure checker asks like any other ask: a reason saying so tells the person nothing.
        return { result: { decision: "ask", model }, ...probability };
      return { result: { decision: "pass", model }, ...probability };
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
      return {
        result: { decision: "error", model: modelLabel, reason: sanitizeAutoReviewReason(reason) },
      };
    }
  }
}
