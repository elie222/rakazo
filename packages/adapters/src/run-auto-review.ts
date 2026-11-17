import type { AgentRuntimeEvent, AutoReviewProvider } from "@rakazo/adapter-kit";
import { recordUsage } from "@rakazo/db";
import type { AutoReviewChecker } from "./auto-review.js";
import {
  autoReviewTimeoutMs,
  isAutoReviewCheckerConfigured,
  resolveAutoReviewProviderKind,
} from "./auto-review.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import { findConnectedModelCredential, hasHostedModelCredits } from "./model-selection.js";
import { operatorReviewObserver } from "./operator-review-usage.js";
import { modelCreditBillingEnabled, resolveModelKey } from "./run-model.js";
/** The Auto Review provider that judges a run's action with one checker choice. */
export async function autoReviewCheckerProvider(
  deps: ExecutorDeps,
  scope: { runId: string; spaceId: string; userId: string; botId: string; threadId: string },
  options: {
    injectedReview?: AutoReviewProvider;
    memberChecker: boolean;
    backups?: readonly { provider: string; modelId: string }[];
    registerSecrets: (values: string[]) => void;
  },
  checker: AutoReviewChecker,
): Promise<AutoReviewProvider> {
  const { runId, spaceId, userId, botId, threadId } = scope;
  const { injectedReview, memberChecker, backups, registerSecrets } = options;
  if (injectedReview) return injectedReview;
  const deploymentChoice =
    !memberChecker &&
    !checker.credentialId &&
    !checker.creditOfferingId &&
    !backups?.some(
      (choice) => choice.provider === checker.provider && choice.modelId === checker.model,
    );
  const kind =
    memberChecker || (checker.provider !== "jev" && checker.provider !== "scripted")
      ? "llm"
      : resolveAutoReviewProviderKind();
  // Only the included decision checker uses operator auth without a personal connection.
  const included =
    deploymentChoice &&
    Boolean(decisionModel(checker.provider, checker.model)) &&
    isAutoReviewCheckerConfigured({ checker }) &&
    !process.env.RAKAZO_AUTO_REVIEW_PROVIDER?.trim() &&
    !process.env.RAKAZO_AUTO_REVIEW_MODEL?.trim() &&
    (await modelCreditBillingEnabled(deps));
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
  const operatorFunded =
    deploymentChoice &&
    !reviewCredential &&
    (Boolean(decisionModel(checker.provider, checker.model)) ||
      kind === "jev" ||
      kind === "scripted");
  const operatorObserver = operatorFunded
    ? operatorReviewObserver(deps.prisma, {
        spaceId,
        userId,
        botId,
        runId,
        parentRunId: runId,
        operationId: `auto-review:${runId}`,
        operationKind: "setup",
      })
    : undefined;
  if (kind === "jev" || kind === "scripted") {
    return createAutoReviewProvider(kind, { callObserver: operatorObserver });
  }
  if (
    (memberChecker ||
      checker.credentialId ||
      backups?.some(
        (choice) => choice.provider === checker.provider && choice.modelId === checker.model,
      )) &&
    !reviewCredential &&
    !checker.creditOfferingId &&
    !(await hasHostedModelCredits(deps.prisma, { userId, spaceId }, checker.provider))
  ) {
    throw new Error("Selected checker connection is unavailable");
  }
  const judgeKey = await resolveModelKey(
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
  const callObserver = operatorObserver ?? judgeKey.callObserver;
  const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      spaceId,
      userId,
      botId,
      parentRunId: runId,
      runId,
      operationId: `auto-review:${runId}`,
      operationKind: "setup",
      fundingSource: operatorFunded ? "operator" : "customer",
    });
  return decisionModel(checker.provider, checker.model)
    ? new DecisionAutoReviewProvider({
        provider: new HttpDecisionProvider("openrouter", {
          apiKey: judgeKey.apiKey ?? "",
          callObserver,
          onUsage: operatorFunded ? undefined : onUsage,
        }),
        providerId: checker.provider,
        model: checker.model,
      })
    : createAutoReviewProvider("llm", {
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
