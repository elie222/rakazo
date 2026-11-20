import type { AgentRuntimeEvent, AutoReviewProvider } from "@rakazo/adapter-kit";
import { recordUsage } from "@rakazo/db";
import type { AutoReviewChecker } from "../../approvals/auto-review.js";
import {
  autoReviewTimeoutMs,
  includedReviewChecker,
  isAutoReviewCheckerConfigured,
  resolveAutoReviewProviderKind,
} from "../../approvals/auto-review.js";
import { createAutoReviewProvider } from "../../approvals/auto-review-factory.js";
import { CheckerConnectionUnavailableError } from "../../approvals/auto-review-failures.js";
import { DecisionAutoReviewProvider } from "../../approvals/decision-auto-review.js";
import { decisionModel } from "../../approvals/decision-models.js";
import type { DecisionModelDescriptor } from "../../approvals/model-descriptor.js";
import { operatorReviewObserver } from "../../approvals/operator-review-usage.js";
import {
  autoReviewShadowModel,
  recordShadowReview,
  ShadowedAutoReviewProvider,
} from "../../approvals/shadow-review.js";
import { DataRetentionRefusedError } from "../../models/endpoints/data-retention.js";
import {
  findConnectedModelCredential,
  hasHostedModelCredits,
} from "../../models/model-selection.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { modelCreditBillingEnabled, resolveModelKey } from "./run-model.js";

/** The deployment's operator-funded reviewer, when hosted credits include one. */
export async function includedAutoReviewChecker(
  deps: Pick<ExecutorDeps, "prisma" | "billingEnabled">,
): Promise<AutoReviewChecker | null> {
  return includedReviewChecker(await modelCreditBillingEnabled(deps));
}

/** The Auto Review provider that judges a run's action with one checker choice. */
export async function autoReviewCheckerProvider(
  deps: ExecutorDeps,
  scope: {
    runId: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    /** Names the reviewed action on the review's usage records. */
    operationId: string;
    /** The reviewed action's effect, which a shadow review's record names. */
    effectId?: string;
  },
  options: {
    injectedReview?: AutoReviewProvider;
    memberChecker: boolean;
    registerSecrets: (values: string[]) => void;
  },
  checker: AutoReviewChecker,
): Promise<AutoReviewProvider> {
  const { runId, spaceId, userId, botId, threadId, operationId, effectId } = scope;
  const { injectedReview, memberChecker, registerSecrets } = options;
  if (injectedReview) return injectedReview;
  const deploymentChoice = !memberChecker && !checker.credentialId && !checker.creditOfferingId;
  const kind =
    memberChecker || (checker.provider !== "jev" && checker.provider !== "scripted")
      ? "llm"
      : resolveAutoReviewProviderKind();
  const hosted =
    deploymentChoice &&
    (Boolean(decisionModel(checker.provider, checker.model)) ||
      kind === "jev" ||
      kind === "scripted") &&
    (await modelCreditBillingEnabled(deps));
  // Only the included decision checker uses operator auth without a personal connection.
  const included =
    hosted &&
    Boolean(decisionModel(checker.provider, checker.model)) &&
    isAutoReviewCheckerConfigured({ checker });
  const reviewCredential =
    checker.creditOfferingId || included || kind === "jev" || kind === "scripted"
      ? null
      : await findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          { userId, spaceId },
          checker.provider,
          checker.model,
          { credentialId: checker.credentialId },
        );
  const operatorFunded = hosted && !reviewCredential;
  const attribution = {
    spaceId,
    userId,
    botId,
    runId,
    parentRunId: runId,
    operationId,
    operationKind: "setup" as const,
  };
  const operatorObserver = operatorFunded
    ? operatorReviewObserver(deps.prisma, attribution)
    : undefined;
  const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      spaceId,
      userId,
      botId,
      parentRunId: runId,
      runId,
      operationId,
      operationKind: "setup",
      fundingSource: operatorFunded ? "operator" : "customer",
    });
  if (kind === "jev" || kind === "scripted") {
    return createAutoReviewProvider(kind, {
      callObserver: operatorObserver,
      onUsage: operatorFunded ? undefined : onUsage,
    });
  }
  if (
    (memberChecker || checker.credentialId) &&
    !reviewCredential &&
    !checker.creditOfferingId &&
    !(await hasHostedModelCredits(deps.prisma, { userId, spaceId }, checker.provider))
  ) {
    throw new CheckerConnectionUnavailableError();
  }
  const decision = decisionModel(checker.provider, checker.model);
  const deploymentKey =
    deploymentChoice && !reviewCredential ? decision?.deploymentApiKey(process.env) : undefined;
  if (deploymentKey) registerSecrets([deploymentKey]);
  const judgeKey = deploymentKey
    ? null
    : await resolveModelKey(
        deps,
        userId,
        spaceId,
        reviewCredential,
        checker.provider,
        checker.model,
        registerSecrets,
        {
          creditOfferingId: checker.creditOfferingId,
          requireStoredSecret: Boolean(checker.credentialId),
          operatorFunded,
        },
      );
  const callObserver = operatorObserver ?? judgeKey?.callObserver;
  if (decision && judgeKey?.zeroDataRetention && !decision.dataRetentionControl) {
    throw new DataRetentionRefusedError("Selected checker cannot restrict data retention");
  }
  const decisionReviewer = (
    model: DecisionModelDescriptor,
    id: string,
    observer: typeof callObserver,
  ) =>
    new DecisionAutoReviewProvider({
      provider: model.create({
        apiKey: deploymentKey ?? judgeKey?.apiKey ?? "",
        ...(judgeKey?.zeroDataRetention ? { zeroDataRetention: true } : {}),
        callObserver: observer,
        onUsage: operatorFunded ? undefined : onUsage,
      }),
      providerId: checker.provider,
      model: id,
      calibration: model.calibration,
    });
  if (decision) {
    const reviewer = decisionReviewer(decision, checker.model, callObserver);
    // Only the included reviewer runs a deployment's trial model, on the same operator key and
    // built like it, so it is sent under the same data retention rule.
    const shadow = included && deploymentKey ? autoReviewShadowModel(decision) : undefined;
    if (!shadow) return reviewer;
    return new ShadowedAutoReviewProvider({
      primary: reviewer,
      shadow: decisionReviewer(
        shadow,
        shadow.id,
        operatorReviewObserver(deps.prisma, {
          ...attribution,
          operationId: `shadow:${operationId}`,
        }),
      ),
      record: (review) => recordShadowReview({ spaceId, runId, threadId, effectId }, review),
    });
  }
  if (!judgeKey) throw new CheckerConnectionUnavailableError();
  return createAutoReviewProvider("llm", {
    llm: {
      onUsage,
      runtime: deps.runtime,
      checker,
      apiKey: judgeKey.oauth ? undefined : judgeKey.apiKey,
      callObserver,
      accountId: judgeKey.accountId,
      gatewayId: judgeKey.gatewayId,
      projectId: judgeKey.projectId,
      region: judgeKey.region,
      zeroDataRetention: judgeKey.zeroDataRetention,
      baseUrl: judgeKey.baseUrl,
      headers: judgeKey.headers,
      allowPrivateEndpoint: judgeKey.allowPrivateEndpoint,
      cacheCapabilities: judgeKey.cacheCapabilities,
      contextWindow: judgeKey.contextWindow,
      maxTokens: judgeKey.maxTokens,
      reasoning: judgeKey.reasoning,
      oauth: judgeKey.oauth
        ? {
            credential: judgeKey.oauth,
            persist: judgeKey.persistOAuth,
            refresh: judgeKey.refreshOAuth,
            retire: judgeKey.retireOAuth,
          }
        : undefined,
      runId,
      spaceId,
      userId,
      botId,
      threadId,
      timeoutMs: autoReviewTimeoutMs(),
    },
  });
}
