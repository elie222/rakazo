import type {
  AdapterContext,
  AgentToolExecutionObserver,
  AutoReviewRequest,
  ConnectorCall,
} from "@rakazo/adapter-kit";
import {
  applyJudgeDecision,
  approvalModeFromPreference,
  BACKGROUND_HELPER_TRIGGER,
  batchActions,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  decisiveActionApprovalRules,
  displayName,
  HELPER_RESULT_TRIGGER,
  humanizeToolName,
  outboundSiteGate,
  outsideRunToolRequiresApproval,
  planActionGate,
  redactSecrets,
  repeatsDeniedAction,
  resolveActionApprovalForTools,
  SITE_SENDING_TOOLS,
  savedContextWriteNeedsReview,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
} from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { AuditEventInput } from "@rakazo/db";
import { recordAuditEvent, runSecretKind } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { ApprovalCardOptions } from "../../approvals/approval-ask.js";
import {
  approvalActionName,
  buildApprovalAskBlock,
  MAX_FETCH_URL_LENGTH,
} from "../../approvals/approval-ask.js";
import {
  boundDirectApprovalDetails,
  DENIED_ACTION_ERROR,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "../../approvals/approval-effect.js";
import { scheduleApprovalExpiry } from "../../approvals/approval-expiry.js";
import type { AutoReviewChecker } from "../../approvals/auto-review.js";
import {
  isAutoReviewCheckerConfigured,
  redactToolArgsForReview,
  resolveAutoReviewChecker,
} from "../../approvals/auto-review.js";
import type { AutoReviewCandidate } from "../../approvals/auto-review-backups.js";
import { reviewWithBackups } from "../../approvals/auto-review-backups.js";
import { reviewOwnerMessages } from "../../approvals/review-owner-messages.js";
import { pagePaymentPrecheck, paysWithWallet } from "../../billing/spending-gate.js";
import { reportBotMessageWait } from "../../messaging/bot-messages.js";
import { findConnectedModelCredential } from "../../models/model-selection.js";
import { paidRequestEffect } from "../../payments/paid-request.js";
import type { PurchaseApproval } from "../../payments/purchase-gate.js";
import { PURCHASE_CHECKED_TOOLS, purchaseApprovalOf } from "../../payments/purchase-gate.js";
import { asksRoutineEvents } from "../../routines/routine-triggers.js";
import { resolveCompletedSecretLeftover } from "../../secrets/run-secret.js";
import { scheduleRunSecretsExpiry } from "../../secrets/run-secrets-expiry.js";
import { RAKAZO_DOCS_URLS } from "../../tools/builtin-skills.prompt.js";
import { CATALOG_LOAD, CATALOG_SEARCH } from "../../tools/lazy-tool-catalog.js";
import { watchFromTool } from "../../tools/schedule-tools.js";
import type { RunContext, RunTrust } from "../assembly/run-context.js";
import {
  isRunTainted,
  nextMutatingEffectOccurrence,
  pauseForApproval,
  pauseForSecret,
  persistTurnCheckpoint,
} from "../assembly/run-context.js";
import { connectorTrustKeys } from "../assembly/run-trust.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import {
  CATALOG_APPROVAL_TOOL,
  claimEffect,
  completeEffect,
  recordEffect,
  uncertainEffectError,
} from "../lifecycle/run-effects.js";
import { enqueueSteeringContinuation, renewRunLease } from "../lifecycle/run-lifecycle.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import { autoReviewCheckerProvider, includedAutoReviewChecker } from "../turn/run-auto-review.js";
import { refusal } from "../turn/tool-refusal.js";
import type { ToolRequest } from "./run-tool-request.js";
import { BUILTIN_AGENT_TOOL_NAMES, READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { callMediaTool } from "./run-tools-files.js";
import { callPaidService } from "./run-tools-integrations.js";
import { USER_COMPUTER_TOOLS, userComputerGate } from "./run-tools-user-computer.js";

export type AppliedEffect = Awaited<ReturnType<typeof recordEffect>>;

/** A tool call that passed its approval gate, as tool handlers receive it. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly executionId: string;
  readonly observer: AgentToolExecutionObserver | undefined;
  readonly connectorCall: ConnectorCall;
  /** Idempotency key of this call's effect; also the delivery key of what it sends. */
  readonly effectKey: string;
  /** The effect recorded for this call. Read-only tools that need no approval have none. */
  readonly applied: AppliedEffect | undefined;
  readonly nextApprovedTool: string | undefined;
  /** A gated call that policy or the reviewer allowed without asking. */
  readonly bypassApproval: boolean;
  /**
   * The approved payment this call presses, counted against the user's spending limit just before
   * the press: the handler records it then, so a call that stops earlier never uses the room.
   */
  readonly spend: PurchaseApproval | undefined;
  /** This call moved its effect to executing. request_secret can hand the claim back. */
  claimedEffect: boolean;
  /** Store the result on the effect; false when it could not be stored. */
  readonly persistEffectResult: (result: unknown) => Promise<boolean>;
  /** Store the result and return it, or an uncertain-effect result when storing failed. */
  readonly finish: (result: unknown) => Promise<unknown>;
  /** Claim the effect to execute it, or return what an earlier attempt already settled. */
  readonly claimOrReturn: (from: "approved" | "intended") => Promise<unknown | undefined>;
}

export type ToolHandler = (ctx: RunContext, call: ToolCall) => Promise<unknown>;
export type ToolHandlers = Record<string, ToolHandler>;

type GateOutcome = { result: unknown; replayed?: true } | { call: ToolCall };

type ToolReview = {
  name: string;
  args: Record<string, unknown>;
  connectorKind: ReturnType<typeof connectorKindFromToolName>;
  newSite: boolean;
  savedContextWrite: boolean;
  fetchUrl: string | undefined;
  matchingRules: ReturnType<typeof resolveActionApprovalForTools>["matchingRules"];
  gated: boolean;
  applied: AppliedEffect | undefined;
  injectedReview: ExecutorDeps["autoReview"];
  checker: AutoReviewChecker | null | undefined;
  reviewSettings: Awaited<ReturnType<RunTrust["loadApprovalModel"]>> | null;
  memberChecker: boolean;
};

/**
 * Decide whether a resolved call runs, asks the owner, is reviewed, or is refused, and record
 * the effect it claims. Returns the result to hand back when the call stops here.
 */
export async function gateToolCall(
  ctx: RunContext,
  request: ToolRequest,
  observer: AgentToolExecutionObserver | undefined,
): Promise<GateOutcome> {
  const { deps, run, runId, context } = ctx;
  const { name, executionId, connectorCall, resolvedTool, nextApprovedTool, approvedEffectKey } =
    request;
  const { replayEffectToolName } = request;
  let { args, effectRequest } = request;
  const viaConnector = !BUILTIN_AGENT_TOOL_NAMES.has(name);
  // Declared effect of the operation this call dispatches (installed API method and
  // flag). Install config is immutable per route resource, so it cannot drift before
  // execute; a catalog call uses the tool it was just resolved to.
  const connectorTool = viaConnector ? (resolvedTool ?? ctx.tools.connector.get(name)) : undefined;
  const declaredReadOnly = connectorTool?.readOnly;
  // A batch tool names the actions it runs in its arguments, so rules and the read/write
  // check look at each action, never the batch tool. An entry naming no action asks.
  const batch = connectorTool?.batch ? batchActions(connectorTool.batch, args) : undefined;
  const unidentifiedAction = Boolean(batch && !batch.complete);
  const approvalName = connectorCall.route?.connectionId ? connectorCall.route.toolName : name;
  const approvalToolNames = batch?.actions.length ? batch.actions : [approvalName];
  // Search and load return a list or a schema. They never call the connector.
  const catalogControlRead =
    !connectorCall.route?.connectionId &&
    !connectorCall.route?.resourceId &&
    (connectorCall.route?.toolName === CATALOG_SEARCH ||
      connectorCall.route?.toolName === CATALOG_LOAD);
  // A batch tool declared as a write makes each of its actions one.
  const declaredReadOnlyFor = (toolName: string) =>
    toolName === approvalName || toolName === name || declaredReadOnly === false
      ? declaredReadOnly
      : ctx.tools.connector.get(toolName)?.readOnly;
  const connectorProviders = ctx.tools.connectedPlugins.map((plugin) => plugin.provider);
  const connectorKind = connectorKindFromToolName(approvalName, connectorProviders);
  const watch = name === "schedule_create" ? watchFromTool(args.watch) : undefined;
  const httpWatch = watch?.kind === "http";
  // paid_request with only a purchase id sends the request its approval already named.
  const sendsToSite =
    httpWatch || (SITE_SENDING_TOOLS.has(name) && (name === "web_fetch" || args.url !== undefined));
  const fetchUrl = sendsToSite
    ? normalizedHttpUrl(String(httpWatch ? watch.url : (args.url ?? "")))
    : undefined;
  const fetchSite = fetchUrl ? urlSite(fetchUrl) : undefined;
  if (sendsToSite && !fetchSite)
    return { result: refusal("fetch_url_invalid", "url must be an http(s) URL") };
  if (fetchUrl && fetchUrl.length > MAX_FETCH_URL_LENGTH)
    return {
      result: refusal(
        "fetch_url_too_long",
        `url must be at most ${MAX_FETCH_URL_LENGTH} characters`,
      ),
    };
  // The card, the stored effect and the request all use the URL the gate checked.
  if (fetchUrl) {
    args = httpWatch ? { ...args, watch: { ...watch, url: fetchUrl } } : { ...args, url: fetchUrl };
    effectRequest = name === "paid_request" ? paidRequestEffect(args) : args;
  }
  const connectorTrusts = connectorTrustKeys(
    batch?.actions,
    connectorCall.route,
    connectorKind,
    connectorProviders,
  );
  const siteGate =
    fetchUrl && fetchSite
      ? outboundSiteGate({
          site: fetchSite,
          trusted:
            ctx.trust.searchResultUrls.has(fetchUrl) ||
            (name === "web_fetch" && RAKAZO_DOCS_URLS.includes(fetchUrl)) ||
            (await ctx.trust.loadTrustedSites()).has(fetchSite),
          rules: await ctx.trust.loadApprovalRules(),
        })
      : "allow";
  // A tool watch repeats its read unattended, so it passes the read check that call would now.
  const watchedTool = watch?.kind === "tool" ? watch.tool : undefined;
  const readTrusts = watchedTool
    ? connectorTrustKeys(
        undefined,
        ctx.tools.connector.get(watchedTool)?.route,
        connectorKindFromToolName(watchedTool, connectorProviders),
        connectorProviders,
      )
    : viaConnector &&
        !unidentifiedAction &&
        (catalogControlRead ||
          approvalToolNames.every(
            (toolName) => !connectorToolRequiresApproval(toolName, declaredReadOnlyFor(toolName)),
          ))
      ? connectorTrusts
      : undefined;
  const connectorReadGated =
    readTrusts !== undefined &&
    connectorReadRequiresApproval({
      tainted: await isRunTainted(ctx),
      connectorTrusted: await ctx.trust
        .loadTrustedConnectors()
        .then((trusted) => readTrusts.every((trust) => trusted.has(trust))),
    });
  // Unattended shell execution or repeated HTTP requests need a person's approval once;
  // neither an allow rule nor an automatic reviewer may create them.
  const unattendedWatch = watch?.kind === "command" || httpWatch;
  // A routine's prompt counts as the owner's words when it runs, so the sites it names are
  // ones its runs may fetch. Once outside content entered this run, a routine naming a site this
  // run was not given trusts the site for every later run, so its card offers no Always allow.
  const scheduleNamesNewSite =
    (name === "schedule_create" ||
      name === "create_child_routine" ||
      (name === "schedule_update" && Boolean(args.prompt))) &&
    (await isRunTainted(ctx)) &&
    (await ctx.trust.routineNamesNewSite(String(args.prompt ?? "")));
  // An event trigger opens a standing way in for outside text (a chat app's every message, mail,
  // a webhook), so once outside content entered this run, its card offers no Always allow either.
  const routineAddsEvents =
    (name === "schedule_create" || name === "schedule_update" || name === "create_child_routine") &&
    asksRoutineEvents(args.on) &&
    (await isRunTainted(ctx));
  // A routine runs later as the owner's own words, so one written or rewritten after outside
  // content entered this run goes through the approval mode like any consequential action: text
  // the bot read must not plant a prompt that later runs with the owner's trust.
  const routineWrittenAfterOutside =
    (name === "schedule_create" ||
      name === "create_child_routine" ||
      (name === "schedule_update" && (Boolean(args.prompt) || asksRoutineEvents(args.on)))) &&
    (await isRunTainted(ctx));
  const savedContextWriteReviewed = await savedContextWriteNeedsReview(name, () =>
    isRunTainted(ctx),
  );
  // Outside text only ever informs the approval model: these go to it in Auto, and nowhere else.
  const reviewOnly =
    connectorReadGated ||
    savedContextWriteReviewed ||
    (Boolean(request.settingsChange) && (await isRunTainted(ctx)));
  const { purchase, cardUse, loginUse } = request;
  // Saved logins that ask first require the owner on every use, like saved cards.
  const paying = Boolean(purchase) || Boolean(cardUse) || Boolean(loginUse);
  const requiresApprovalByDefault =
    request.heldForApproval ||
    paying ||
    unattendedWatch ||
    routineWrittenAfterOutside ||
    siteGate === "new" ||
    unidentifiedAction ||
    (!catalogControlRead &&
      approvalToolNames.some(
        (toolName) =>
          toolRequiresApproval(toolName, viaConnector, declaredReadOnlyFor(toolName)) ||
          (!viaConnector && outsideRunToolRequiresApproval(run.trigger, toolName)),
      ));
  // A reviewed call still fails closed when its review errors, and keeps its approval key.
  const gated = requiresApprovalByDefault || reviewOnly;
  // In Ask and Auto these ask a person every time, whatever started the run.
  const mandatoryInAnyRun = paying || unattendedWatch || toolRequiresExplicitApproval(name);
  // Outside text may have asked for these, so an Always allow rule saved for calls the owner asked
  // for does not skip them; they still go through the approval mode.
  const ignoresAllowRules = routineWrittenAfterOutside || request.ignoresAllowRules;
  // No allow rule skips these, and without them the tool needs no approval, so "Always allow"
  // on their card would save a rule that never takes effect.
  const asksEveryTime =
    (unattendedWatch || scheduleNamesNewSite || routineAddsEvents || ignoresAllowRules) &&
    !toolRequiresApproval(name, viaConnector);
  // Never ask runs everything else: only another owner's connection could have been steered into it.
  const guardedInNeverAsk = name === "respond_agent_connection";
  const resolvedRules = resolveActionApprovalForTools({
    tools: approvalToolNames.map((toolName) => ({
      name: toolName,
      aliases: toolName === approvalName && approvalName !== name ? [name] : undefined,
      connectorKind:
        toolName === approvalName
          ? connectorKind
          : connectorKindFromToolName(toolName, connectorProviders),
      readOnly: declaredReadOnlyFor(toolName),
    })),
    wrapper: batch ? { name, connectorKind } : undefined,
    site: fetchSite,
    rules: await ctx.trust.loadApprovalRules(),
  });
  const approvalResolved =
    unidentifiedAction && resolvedRules.decision === "allow"
      ? { ...resolvedRules, decision: "ask" as const }
      : ignoresAllowRules && resolvedRules.source === "always_allow"
        ? { ...resolvedRules, source: "default" as const }
        : resolvedRules;
  const mode = approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference());
  const reviewable = mode === "auto" && !mandatoryInAnyRun;
  const injectedReview = reviewable ? deps.autoReview : undefined;
  const reviewSettings = !reviewable || injectedReview ? null : await ctx.trust.loadApprovalModel();
  const memberChecker = reviewSettings?.primarySource === "member";
  const checker = !reviewable
    ? undefined
    : reviewSettings
      ? reviewSettings.primary
        ? {
            provider: reviewSettings.primary.provider,
            model: reviewSettings.primary.modelId,
            thinkingLevel: reviewSettings.primary.thinkingLevel,
            credentialId: reviewSettings.primary.credentialId,
            creditOfferingId: reviewSettings.primary.creditOfferingId,
          }
        : null
      : resolveAutoReviewChecker();
  const checkerConfigured =
    reviewable &&
    (Boolean(injectedReview) ||
      memberChecker ||
      Boolean(reviewSettings?.backups.length) ||
      (checker
        ? isAutoReviewCheckerConfigured({ checker }) ||
          Boolean(
            await findConnectedModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId: run.userId, spaceId: run.spaceId },
              checker.provider,
            ),
          )
        : false));
  const plan = USER_COMPUTER_TOOLS.has(name)
    ? await userComputerGate(ctx, approvalResolved.decision === "deny", name, args, mode)
    : planActionGate({
        resolved: approvalResolved,
        mode,
        mandatory: mandatoryInAnyRun,
        steerable:
          guardedInNeverAsk && mode === "never"
            ? !ctx.source.ownerStartedRun || (await isRunTainted(ctx))
            : undefined,
        consequential: requiresApprovalByDefault,
        reviewOnly,
        checkerConfigured,
        newDestination: siteGate === "new",
        purchase: paying,
      });
  if (plan === "deny") {
    await auditToolCall(ctx, name, "denied", {
      reason: approvalResolved.decision === "deny" ? "rule" : "never_asks",
    });
    return {
      result: refusal(
        "approval_denied",
        approvalResolved.decision === "deny"
          ? `${name} is blocked in this space${blockingRuleSuffix(approvalResolved)}. Don't try it another way; tell the user it's blocked.`
          : `${name} needs the owner's approval because it could have been asked for by someone else, and this space never asks. Don't retry; tell the user.`,
      ),
    };
  }
  // A pay click counts against the user's spending limit, unless it pays with a wallet purchase,
  // which was counted when it was requested. One the limit refuses is refused before the card; the
  // handler counts it for good just before the press.
  const spends = purchase && !paysWithWallet(args) ? purchase : undefined;
  if (spends && nextApprovedTool !== name) {
    const spender = {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: ctx.bot.id,
      threadId: ctx.thread.id,
    };
    const refused = await pagePaymentPrecheck(deps.prisma, spender, spends);
    if (refused) {
      await auditToolCall(ctx, name, "denied", { reason: "spending_limit" });
      return { result: refusal("spending_limit", refused) };
    }
  }
  let reviewReason: string | undefined;
  let gateDecision: "ask" | "allow" = plan === "ask" ? "ask" : "allow";
  // Auto Review passing one URL clears that call only; it does not give the run the whole site.
  let passedByReview = false;
  const needsApprovalEarly = plan === "ask" || plan === "judge";
  // A resumed approval keeps its key even if "Always allow" changed the policy.
  const usesApprovalKey =
    nextApprovedTool || name === "request_secret" || needsApprovalEarly || gated;
  // Count before choosing a key so an approved replay (occurrence 0 / base
  // key) cannot collide with a later identical-args call in this attempt.
  // request_secret stays single-use: retries must reuse the same card. A code is the exception:
  // a wrong or expired one needs a new card, so each request counts, and a retry still finds its
  // own through the saved turn.
  const occurrence =
    (name === "request_secret" && args.oneTimeCode === undefined) || name === "connect_app"
      ? 0
      : nextMutatingEffectOccurrence(
          ctx,
          replayEffectToolName,
          args,
          executionId,
          approvedEffectKey,
        );
  // An approved replay claims the row the user approved. A derived key can differ
  // (another call's occurrence count), which would ask again and strand the approval.
  const effectKey =
    approvedEffectKey ??
    (usesApprovalKey && occurrence === 0
      ? approvalEffectKey(runId, replayEffectToolName, args)
      : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence));
  // Connector read-only hints must not bypass approval, review, or replay decisions.
  // A fetch to a new site is gated like any action, so it needs an effect to approve.
  const applied =
    READ_ONLY_AGENT_TOOLS.has(name) &&
    plan === "allow" &&
    siteGate !== "new" &&
    nextApprovedTool !== name &&
    !approvedEffectKey
      ? undefined
      : await recordEffect(
          deps,
          run,
          replayEffectToolName,
          effectKey,
          effectRequest,
          executionId,
          ctx.state.effects.consumedIds,
          batch && (batch.complete ? batch.actions : []),
        );

  // Refuse a repeat of a tool the user denied earlier in this run. Refusals carry a result,
  // so only real denies match. A stored row is checked only while it still waits for an
  // answer. web_fetch and secret_request target one site per call; request_secret and
  // connect_app name their own target.
  // Browsing goes on after a denied purchase: a purchase is checked against earlier denied purchases
  // on the same site, and other page work against earlier denied page work that bought nothing.
  const pageAction = PURCHASE_CHECKED_TOOLS.has(name);
  const repeatChecked =
    applied &&
    (!applied.duplicate || applied.effect.status === "intended") &&
    !["web_fetch", "secret_request", "request_secret", "connect_app"].includes(name);
  const deniedEarlier = repeatChecked
    ? (
        await deps.prisma.externalEffect.findMany({
          where: { runId, status: "denied", kind: replayEffectToolName },
          select: { request: true, result: true },
        })
      ).flatMap((effect) =>
        effect.result == null &&
        (!pageAction ||
          purchaseApprovalOf(
            (effect.request as { purchaseApproval?: unknown } | null)?.purchaseApproval,
          )?.site === purchase?.site)
          ? [
              boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL)?.args ??
                effect.request,
            ]
          : [],
      )
    : [];
  if (
    applied &&
    repeatsDeniedAction({ toolName: replayEffectToolName, args, denied: deniedEarlier })
  ) {
    await deps.prisma.externalEffect.updateMany({
      where: { id: applied.effect.id, status: "intended" },
      data: { status: "denied", result: { refused: "repeat" } },
    });
    return { result: refusal("action_denied_repeat", DENIED_ACTION_ERROR) };
  }

  const runAutoReview = async () => {
    const judged = await reviewToolCall(ctx, {
      name,
      args,
      connectorKind,
      newSite: siteGate === "new",
      savedContextWrite: savedContextWriteReviewed,
      fetchUrl,
      matchingRules: approvalResolved.matchingRules,
      gated,
      applied,
      injectedReview,
      checker,
      reviewSettings,
      memberChecker,
    });
    if (!judged) return;
    reviewReason = judged.reason;
    gateDecision = judged.decision;
    passedByReview = judged.decision === "allow";
  };

  if (applied && plan === "judge" && (injectedReview || checker)) {
    if (!applied.duplicate) {
      await runAutoReview();
    } else {
      const priorDecision = applied.effect.reviewDecision;
      if (priorDecision === "ask" || priorDecision === "error") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "ask";
      } else if (priorDecision === "pass") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "allow";
        passedByReview = true;
      } else {
        await runAutoReview();
      }
    }
  } else if (applied?.duplicate && plan === "ask") {
    gateDecision = "ask";
  }
  if (context.signal.aborted) return { result: pauseForApproval(ctx) };

  const needsApproval = gateDecision === "ask";
  const call = createToolCall(ctx, {
    name,
    args,
    executionId,
    observer,
    connectorCall,
    effectKey,
    applied,
    nextApprovedTool,
    bypassApproval: gateDecision === "allow" && gated,
    spend: spends,
  });
  const card = {
    reviewReason,
    summary: request.fleetSummary,
    batch: connectorTool?.batch,
    onceOnly: asksEveryTime,
    outgoingDraft: connectorTool?.outgoingDraft,
    allowOutgoingDraft:
      Boolean(connectorTool?.outgoingDraft || connectorTool?.batch?.outgoingDrafts) &&
      ctx.source.ownerStartedRun &&
      !ctx.source.messagingChannelRun &&
      !ctx.thread.groupId,
  };

  if (applied?.duplicate) {
    const gate = resolveDuplicateEffectGate(applied.effect, name);
    if (gate.action === "return") {
      if (name === "request_secret") {
        const replacementSecret = await deps.prisma.secret.findFirst({
          where: {
            spaceId: run.spaceId,
            userId: run.userId,
            kind: runSecretKind(runId),
          },
          select: { id: true, createdAt: true },
        });
        if (!replacementSecret) return { result: gate.result, replayed: true };
        // Crash between persist and delete leaves the same OTP row. Do not
        // resubmit it to the connector; only newer rows are replacements.
        const effectUpdatedAt = applied.effect.updatedAt;
        if (
          !(effectUpdatedAt instanceof Date) ||
          resolveCompletedSecretLeftover({
            secretCreatedAt: replacementSecret.createdAt,
            effectUpdatedAt,
          }) === "drop_leftover"
        ) {
          await deps.prisma.secret.delete({
            where: { id: replacementSecret.id },
          });
          return { result: gate.result, replayed: true };
        }
      } else {
        return { result: gate.result, replayed: true };
      }
    }
    if (gate.action === "paused") {
      if (name === "request_secret") {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForSecret(ctx) };
        }
        // An intended secret request resumes protected entry below, including
        // recovery after action approval but before the card was committed.
      } else if (!needsApproval) {
        const early = await call.claimOrReturn("intended");
        if (early !== undefined) return { result: early, replayed: true };
      } else {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForApproval(ctx) };
        }
        return { result: await requestApproval(ctx, call, card) };
      }
    } else if (gate.action === "uncertain") {
      return {
        result: await settleToolUncertainty(ctx, call, applied.effect.id, gate.toolName),
        replayed: true,
      };
    } else if (gate.action === "execute") {
      const early = await call.claimOrReturn("approved");
      if (early !== undefined) return { result: early, replayed: true };
    }
  } else if (needsApproval && applied) {
    return { result: await requestApproval(ctx, call, card) };
  } else if (call.bypassApproval && applied) {
    const early = await call.claimOrReturn("intended");
    if (early !== undefined) return { result: early, replayed: true };
  }
  // Past the gate: this destination is now one the run was given. A search result's exact
  // URL trusts only that URL, never the rest of its site, and a URL Auto Review passed (judged on
  // what that URL carries) trusts nothing beyond itself: the site's next URL is judged again.
  if (fetchSite && siteGate === "new" && !passedByReview)
    (await ctx.trust.loadTrustedSites()).add(fetchSite);
  if (viaConnector) {
    const trusted = await ctx.trust.loadTrustedConnectors();
    for (const trust of connectorTrusts) trusted.add(trust);
  }
  return { call };
}

/** A bot's consequential tool call, recorded in its organization's audit log. */
export async function auditToolCall(
  ctx: RunContext,
  tool: string,
  outcome: "success" | "failure" | "denied",
  metadata: AuditEventInput["metadata"],
  recorded: Pick<AuditEventInput, "action" | "actor"> = {
    action: "tool.call",
    actor: { type: "bot", id: ctx.bot.id, label: ctx.bot.name },
  },
): Promise<void> {
  await recordAuditEvent({
    ...recorded,
    spaceId: ctx.run.spaceId,
    target: { type: "tool", id: tool, label: humanizeToolName(tool) },
    outcome,
    runId: ctx.runId,
    threadId: ctx.thread.id,
    metadata,
  });
}

function blockingRuleSuffix(resolved: ReturnType<typeof resolveActionApprovalForTools>): string {
  const labels = decisiveActionApprovalRules(resolved).map((rule) => {
    const value = rule.matchValue.trim().replace(/\s+/g, " ");
    return JSON.stringify(rule.matchKind === "site" ? value : humanizeToolName(value));
  });
  if (labels.length === 0) return "";
  return ` by the saved ${labels.length === 1 ? "rule" : "rules"} ${labels.join(", ")}`;
}

function createToolCall(
  ctx: RunContext,
  fields: Omit<ToolCall, "claimedEffect" | "persistEffectResult" | "finish" | "claimOrReturn">,
): ToolCall {
  const { deps } = ctx;
  const { name, args, applied } = fields;
  const call: ToolCall = {
    ...fields,
    claimedEffect: false,
    persistEffectResult: (result) =>
      applied
        ? completeEffect(
            deps,
            applied.effect.id,
            call.claimedEffect ? "executing" : "intended",
            result,
          )
        : Promise.resolve(true),
    finish: async (result) =>
      (await call.persistEffectResult(result)) ? result : uncertainEffectResult(name, args),
    claimOrReturn: async (from) => {
      if (await claimEffect(deps, ctx.runId, applied!.effect.id, from)) {
        call.claimedEffect = true;
        return undefined;
      }
      const current = await deps.prisma.externalEffect.findUnique({
        where: { id: applied!.effect.id },
      });
      if (current) {
        const retryGate = resolveDuplicateEffectGate(current, name);
        if (retryGate.action === "return") return retryGate.result;
        if (retryGate.action === "uncertain") {
          return settleToolUncertainty(ctx, call, applied!.effect.id, name);
        }
      }
      throw uncertainEffectError(name);
    },
  };
  return call;
}

async function settleToolUncertainty(
  ctx: RunContext,
  call: ToolCall,
  effectId: string,
  toolName: string,
) {
  if (call.name === "generate_image" || call.name === "generate_video") {
    const recovered = await callMediaTool(ctx, call, true);
    if (
      recovered !== undefined &&
      (await completeEffect(ctx.deps, effectId, "executing", recovered))
    )
      return recovered;
  }
  if (call.name === "service_call") {
    const recovered = await callPaidService(ctx, call).catch(() => undefined);
    // Only an answer the provider settled carries a cost; anything else stays uncertain.
    if (
      recovered &&
      "cost_usd" in recovered &&
      (await completeEffect(ctx.deps, effectId, "executing", recovered))
    )
      return recovered;
  }
  return settleUncertainEffect(ctx.deps.prisma, effectId, toolName, call.args);
}

/** Ask the owner through an approval card. Parallel calls share the first call's pause. */
function requestApproval(ctx: RunContext, call: ToolCall, card: ApprovalCardOptions) {
  const { approval } = ctx.state;
  // Parallel calls can need approval at once. Only the first saves the turn and shows
  // its card; the others wait for that pause. Otherwise a later call's save could make
  // the turn resume a call other than the one the user approved.
  if (approval.request) return approval.request.then(() => pauseForApproval(ctx));
  approval.request = showApprovalCard(ctx, call, card);
  return approval.request;
}

async function showApprovalCard(ctx: RunContext, call: ToolCall, card: ApprovalCardOptions) {
  const { deps, run, runId, bot, thread } = ctx;
  const { name, args, executionId, applied } = call;
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
    // Another worker owns the run now; exit without leaving a local pause card.
    return pauseForApproval(ctx);
  }
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    onPaused: async (tx) => {
      await scheduleRunSecretsExpiry(deps.jobs, runId)(tx);
      await scheduleApprovalExpiry(deps.jobs, tx, {
        trigger: run.trigger,
        runId,
        effectId: applied!.effect.id,
      });
    },
    blocks: [
      buildApprovalAskBlock(
        applied!.effect.id,
        name,
        name === "update_bot" && "previousInstructions" in args ? { ...args, botId: bot.id } : args,
        ctx.secrets,
        card,
      ),
    ],
  });
  // pauseRunForInput returning false after a successful renew means the run row no
  // longer matches this worker. Exiting via pauseForApproval() would leave the run
  // stuck in "running" with no ask card — fail instead so the user can retry.
  if (!paused) {
    throw new Error("Could not pause this run for approval; try sending again.");
  }
  await enqueueSteeringContinuation(deps, paused.continuationRunId);
  await reportBotMessageWait(deps, run, bot, `approve ${name}`, ctx.attempt.id);
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs approval`,
    // Only the action, with no verb: the card's title can name a recipient or subject, and a call
    // can decline rather than allow, so both stay on the card.
    body: approvalActionName(name, args, card.batch, ctx.secrets),
    botId: bot.id,
    threadId: thread.id,
  });
  return pauseForApproval(ctx);
}

/**
 * Run the configured reviewer (and its backups) on a call and store its verdict on the
 * effect. Returns nothing when there is no reviewer or the run was cancelled.
 */
async function reviewToolCall(
  ctx: RunContext,
  review: ToolReview,
): Promise<{ reason: string | undefined; decision: "ask" | "allow" } | undefined> {
  const { deps, run, runId, bot, thread, context } = ctx;
  const { name, args, connectorKind, fetchUrl, gated, applied } = review;
  const { injectedReview, checker, reviewSettings, memberChecker } = review;
  if (!injectedReview && !checker && !reviewSettings?.backups.length) return;
  try {
    const delegated =
      run.trigger === BACKGROUND_HELPER_TRIGGER || run.trigger === HELPER_RESULT_TRIGGER;
    // A follow-up's task is a fixed "continue" prompt; the owner's latest words are its message.
    const continuation = run.trigger === "follow_up" || run.trigger === "messaging";
    const userTask = delegated
      ? await ctx.trust.loadOwnerWords()
      : (continuation && (await ctx.trust.loadOwnerWords()).trim()) || ctx.task.prompt;
    // Older helpers and deleted origins cannot establish authorization from their brief.
    if (delegated && !userTask.trim()) return { decision: "ask", reason: undefined };
    const botDescription = redactSecrets(`${bot.name}\n${bot.description}`, ctx.secrets);
    // A webhook run's task prompt carries the delivery, which someone else wrote, so the checker
    // gets only the owner's routine. With no routine to judge against, a person decides.
    const outsideRun = run.trigger === "webhook";
    const ownerWords = outsideRun ? await ctx.trust.loadOwnerWords() : "";
    if (outsideRun && !ownerWords.trim()) return { reason: undefined, decision: "ask" };
    // A new site, or a memory or skill save after outside content, is judged on the owner's own words only:
    // the task prompt of a webhook or bot-started run carries text someone else wrote.
    const ownerWordsOnly = (review.newSite && fetchUrl) || review.savedContextWrite;
    const reviewArgs =
      review.newSite && fetchUrl
        ? { url: redactSecrets(fetchUrl, ctx.secrets) }
        : redactToolArgsForReview(args, ctx.secrets);
    const ownerMessages = reviewOwnerMessages(
      // Extra context only: a failed lookup drops it and never fails the review.
      (
        (await bestEffort("auto_review.owner_messages", ctx.trust.loadEarlierOwnerMessages())) ?? []
      ).map((text) => redactSecrets(text, ctx.secrets)),
    );
    const reviewRequest: AutoReviewRequest = {
      toolName: name,
      connectorKind,
      args: reviewArgs,
      userTask: redactSecrets(
        outsideRun ? ownerWords : ownerWordsOnly ? await ctx.trust.loadOwnerWords() : userTask,
        ctx.secrets,
      ),
      botDescription,
      matchingRules: review.matchingRules,
      ...(review.newSite && fetchUrl ? { newSite: true } : {}),
      ...(review.savedContextWrite ? { savedContextWrite: true } : {}),
      ...(ownerMessages.length ? { ownerMessages } : {}),
    };
    const reviewContext: AdapterContext = {
      operationId: `auto-review:${runId}`,
      traceId: `auto-review:${runId}`,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      runId,
      signal: context.signal,
    };
    const checkerProvider = (candidate: AutoReviewCandidate) =>
      autoReviewCheckerProvider(
        deps,
        {
          runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          threadId: thread.id,
        },
        {
          injectedReview,
          memberChecker: candidate.role !== "default",
          registerSecrets: (values) => ctx.secrets.push(...values),
        },
        candidate,
      );
    // The fallback is extra: failing to look it up must not keep the chosen checkers from running.
    const included = injectedReview
      ? null
      : await bestEffort("auto_review.included_checker", includedAutoReviewChecker(deps));
    const includedIsPrimary =
      included &&
      checker &&
      !memberChecker &&
      checker.provider === included.provider &&
      checker.model === included.model &&
      !checker.credentialId &&
      !checker.creditOfferingId;
    const judge = await reviewWithBackups(
      [
        ...(checker
          ? [{ ...checker, role: memberChecker ? ("member" as const) : ("default" as const) }]
          : injectedReview
            ? [{ provider: "injected", model: "injected", role: "default" as const }]
            : []),
        ...(reviewSettings?.backups.map((choice) => ({
          provider: choice.provider,
          model: choice.modelId,
          thinkingLevel: choice.thinkingLevel,
          credentialId: choice.credentialId,
          creditOfferingId: choice.creditOfferingId,
          role: "backup" as const,
        })) ?? []),
        // A member's unusable choice falls back to the deployment's included reviewer.
        ...(included && !includedIsPrimary ? [{ ...included, role: "default" as const }] : []),
      ],
      async (checker) => {
        const provider = await checkerProvider(checker);
        return provider.review(reviewRequest, reviewContext);
      },
      context.signal,
    );
    if (context.signal.aborted) return;
    const verdict = {
      reason: judge.reason,
      decision: applyJudgeDecision({ decision: judge.decision, consequential: gated }),
    };
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: {
          reviewDecision: judge.decision,
          reviewReason: judge.reason,
          reviewModel: judge.model,
        },
      });
    }
    await auditAutoReview(ctx, name, applied, judge.decision, judge.model);
    return verdict;
  } catch {
    // Cancellation must not write a review the next attempt would reuse.
    if (context.signal.aborted) return;
    // Auth/refresh failures must fail closed like a checker error, not fail the run.
    const reviewReason = "Checker could not authenticate.";
    const verdict = {
      reason: reviewReason,
      decision: applyJudgeDecision({ decision: "error", consequential: gated }),
    };
    const reviewModel = checker
      ? `${checker.provider}/${checker.model}`
      : (injectedReview?.describe().id ?? "auto-review");
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: { reviewDecision: "error", reviewReason, reviewModel },
      });
    }
    await auditAutoReview(ctx, name, applied, "error", reviewModel);
    return verdict;
  }
}

function auditAutoReview(
  ctx: RunContext,
  tool: string,
  applied: AppliedEffect | undefined,
  decision: string,
  model: string | undefined,
): Promise<void> {
  return auditToolCall(
    ctx,
    tool,
    decision === "error" ? "failure" : "success",
    { effectId: applied?.effect.id, decision },
    { action: "approval.auto_reviewed", actor: { type: "system", label: model } },
  );
}
