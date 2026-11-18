import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentRuntime,
  AutoReviewProvider,
  DecisionProvider,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { escapePromptData } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { EvalPricing, MeasuredCall } from "../evals/measurement.js";
import { SpendBudget, validatePricing } from "../evals/measurement.js";
import type { TrialResult } from "../evals/report.js";
import { redact } from "../evals/report.js";
import type { StoredReport } from "../evals/run-store.js";
import { RunStore } from "../evals/run-store.js";
import type { ApprovalCase, ApprovalCaseResult } from "../evals/suites/approval.js";
import {
  APPROVAL_CASES,
  APPROVAL_FIXTURE_VERSION,
  loadApprovalCases,
  runApprovalCases,
  summarizeApproval,
} from "../evals/suites/approval.js";
import {
  APPROVAL_VARIANTS_VERSION,
  parseApprovalVariant,
  VariantDecisionProvider,
  variantPrompt,
} from "../evals/suites/approval-variants.js";

type ApprovalValues = {
  live?: boolean;
  list?: boolean;
  case?: string[];
  trials?: string;
  connection?: string;
  provider?: string;
  model?: string;
  "api-key-env"?: string;
  "base-url"?: string;
  pricing?: string;
  "spend-cap-usd"?: string;
  "timeout-ms"?: string;
  output?: string;
  "cases-file"?: string;
  variant?: string;
  concurrency?: string;
  protocol?: string;
  store?: string;
  label?: string;
  "reply-mode"?: string;
};

/** Options only the approval suite reads, declared with the rest of the eval CLI's. */
export const APPROVAL_OPTIONS = {
  /** Eval-only reviewer inputs and rubric, such as outside+history; see approval-variants.ts. */
  variant: { type: "string" },
  /** Trials run side by side. */
  concurrency: { type: "string" },
  /** decisions or llm, for a reviewer model the adapter catalog does not list. */
  protocol: { type: "string" },
} as const;

/**
 * Live calibration of the Auto approval reviewer against reviewed cases. The reviewer is the
 * product's own adapter, selected from a model connection or the same env the product reads.
 */
export async function runApprovalSuite(
  values: ApprovalValues,
  meta: {
    codeRevision: string | null;
    workingDiffHash: string | null;
    readConnection: (file: string) => unknown;
  },
) {
  if (values["reply-mode"])
    throw new Error("--reply-mode sets the trial's bots; the approval suite has none");
  const extraCases = values["cases-file"] ? loadApprovalCases(values["cases-file"]) : [];
  const allCases: ApprovalCase[] = [...APPROVAL_CASES, ...extraCases];
  if (new Set(allCases.map((c) => c.id)).size !== allCases.length)
    throw new Error("Case ids must be unique across the suite and --cases-file");
  if (values.list) {
    for (const c of allCases)
      console.log(`${c.id}: expected ${c.expected}${c.category ? ` [${c.category}]` : ""}`);
    return;
  }
  const selected = values.case?.length
    ? allCases.filter((c) => values.case!.includes(c.id))
    : allCases;
  if (!selected.length || values.case?.some((id) => !allCases.some((c) => c.id === id)))
    throw new Error("Unknown eval case; use --list");
  const variant = parseApprovalVariant(values.variant);
  const trials = Number(values.trials);
  const timeoutMs = Number(values["timeout-ms"]);
  const concurrency = Number(values.concurrency ?? "1");
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10)
    throw new Error("Trials must be an integer from 1 to 10");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000)
    throw new Error("Timeout must be at least 1000ms");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Concurrency must be an integer from 1 to 16");
  if (values.protocol && values.protocol !== "decisions" && values.protocol !== "llm")
    throw new Error("Protocol must be decisions or llm");
  const storeDir = values.store ?? process.env.EVAL_RUN_STORE;
  const store = storeDir ? new RunStore(path.resolve(storeDir)) : undefined;
  const categories = new Map(selected.map((c) => [c.id, c.category ?? "built-in"]));
  const byId = new Map(selected.map((c) => [c.id, c]));
  const caseForRun = (runId: string) => {
    const match = /^(.*)-(\d+)$/.exec(runId.replace(/:auto-review$/, ""));
    return match ? byId.get(match[1]!.replace(/^approval-eval-/, "")) : undefined;
  };
  const output = path.resolve(values.output!);
  const results: ApprovalCaseResult[] = [];
  const report = {
    version: 1,
    kind: "approval-calibration-eval",
    startedAt: new Date().toISOString(),
    fixtureVersion: extraCases.length
      ? `${APPROVAL_FIXTURE_VERSION}+${extraCases.length}-local`
      : APPROVAL_FIXTURE_VERSION,
    /** Eval-only reviewer inputs and rubric; `current` is what the product sends today. */
    variant: variant.id,
    variantsVersion: APPROVAL_VARIANTS_VERSION,
    rubricVersion: null as string | null,
    reviewer: null as null | { protocol: "decisions" | "llm"; provider: string; model: string },
    codeRevision: meta.codeRevision,
    workingDiffHash: meta.workingDiffHash,
    controls: { trials, timeoutMs, concurrency },
    pricing: null as EvalPricing | null,
    spendCapUsd: Number(values["spend-cap-usd"]),
    status: "not-run" as "not-run" | "complete" | "stopped",
    reason: null as string | null,
    costSource:
      "Reviewer calls only. Provider reported charge when available, otherwise explicit pricing estimate; unknown stays null.",
    scoring:
      "Agreement is over every result. False-ask rate is over expected-pass results and false-pass rate over expected-ask results. Reviewer errors are unqualified, never passes.",
    limitations: [
      "Each case is a single reviewer call with no matching rules; executor routing, rule matching and Never ask/Ask modes are outside the fixture.",
      "Spend reservations are a guard, not a billing guarantee.",
    ],
    cases: selected.map((c) => c.id),
    categories: Object.fromEntries(categories),
    /** Usage a trial could not be matched to; its cost is missing from the trials. */
    unattributedCalls: 0,
    results,
    summary: summarizeApproval(results, categories),
  };
  const save = () => {
    report.summary = summarizeApproval(results, categories);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  const notRun = (reason: string): never => {
    report.reason = reason;
    save();
    throw new Error(reason);
  };
  save();
  if (!values.live) notRun("Live reviewer execution requires --live; no case was run");
  loadRootEnv();

  // Direct source imports keep the adapters barrel, and its database client, out of this suite.
  const autoReview = await import("../../../adapters/src/approvals/auto-review.ts");
  const { decisionModel } = await import("../../../adapters/src/approvals/decision-models.ts");
  const { APPROVAL_DECISION_RUBRIC_VERSION } = await import(
    "../../../adapters/src/approvals/decision-auto-review.ts"
  );
  report.rubricVersion = APPROVAL_DECISION_RUBRIC_VERSION;

  let connection: {
    provider: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean;
  };
  if (values.connection || values.provider) {
    const parsed = ModelConnectInputSchema.safeParse(
      values.connection
        ? meta.readConnection(values.connection)
        : {
            provider: values.provider,
            modelId: values.model,
            apiKey: values["api-key-env"] ? process.env[values["api-key-env"]] : undefined,
            baseUrl: values["base-url"],
            label: "Approval reviewer",
          },
    );
    if (!parsed.success || !parsed.data.modelId?.trim())
      return notRun(
        "A valid reviewer connection is required: --connection with models/connect JSON, or --provider --model --api-key-env",
      );
    connection = { ...parsed.data, modelId: parsed.data.modelId, headers: parsed.data.headers };
  } else {
    // The same selection the product makes from RAKAZO_AUTO_REVIEW_* and the deployment model.
    const checker = autoReview.resolveAutoReviewChecker(process.env);
    const envKeys: Record<string, string | undefined> = {
      [autoReview.JEV_AUTO_REVIEW_PROVIDER]: autoReview.typesafeApiKey(process.env),
      openrouter: process.env.OPENROUTER_API_KEY?.trim(),
      anthropic: process.env.ANTHROPIC_API_KEY?.trim(),
    };
    if (!checker || checker.provider === autoReview.SCRIPTED_AUTO_REVIEW_PROVIDER)
      return notRun("No live approval reviewer is configured; pass --connection or set its env");
    const apiKey = envKeys[checker.provider];
    if (!apiKey)
      return notRun(
        "The configured approval reviewer has no key in env; pass --connection for other providers",
      );
    connection = { provider: checker.provider, modelId: checker.model, apiKey };
  }
  const catalog = decisionModel(connection.provider, connection.modelId);
  const isJev = connection.provider === autoReview.JEV_AUTO_REVIEW_PROVIDER;
  // A decision model not in the adapter catalog yet is named with --protocol and priced with --pricing.
  const protocol =
    (values.protocol as "decisions" | "llm" | undefined) ??
    (catalog || isJev ? "decisions" : "llm");
  if (protocol === "decisions" && !catalog && !isJev && connection.provider !== "openrouter")
    return notRun("The decision protocol is available for catalog models and OpenRouter only");
  if (protocol === "llm" && variant.parts.has("split"))
    return notRun("The split rubric needs a decision-protocol reviewer");
  report.reviewer = { protocol, provider: connection.provider, model: connection.modelId };

  let pricing: EvalPricing;
  try {
    pricing = values.pricing
      ? validatePricing(JSON.parse(readFileSync(values.pricing, "utf8")))
      : validatePricing(
          catalog
            ? {
                source: "adapter decision model catalog",
                version: catalog.id,
                input: catalog.inputUsdPerMillion,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              }
            : null,
        );
  } catch {
    return notRun("Live execution requires --pricing with explicit USD per million rates");
  }
  report.pricing = pricing;
  const budget = new SpendBudget(report.spendCapUsd, pricing);
  // Trials can run side by side, so each call is matched to its trial by the run id it was made for.
  const calls: Array<MeasuredCall & { runId?: string }> = [];
  const callRuns = new Map<string, string>();
  const runOf = (runId: string | undefined) => runId?.replace(/:auto-review$/, "");
  const record = (usage: { callId?: string } & Omit<MeasuredCall, "id">) => {
    const id = usage.callId ?? randomUUID();
    const runId = callRuns.get(id);
    if (!runId && concurrency > 1) report.unattributedCalls++;
    calls.push({ ...usage, id, runId });
  };
  const drainCalls = (runId: string) => {
    const mine = calls.filter((c) => c.runId === runId || (!c.runId && concurrency === 1));
    for (const call of mine) calls.splice(calls.indexOf(call), 1);
    return mine;
  };
  const callObserver: ModelCallObserver = {
    beforeCall: (call) => {
      const runId = runOf(call.runId);
      if (call.callId && runId) callRuns.set(call.callId, runId);
      if (
        call.provider !== (isJev ? "typesafe" : connection.provider) ||
        call.modelId !== connection.modelId
      )
        throw new Error("Reviewer model has no configured pricing");
      return budget.reserve(
        call.inputTokensEstimate,
        call.maxOutputTokens,
        call.cacheWriteRetention,
      );
    },
    afterCall: (id, usage) => budget.settleUsage(id, usage),
  };
  const apiKey = connection.apiKey ?? "";
  // A variant wraps the product's decision provider, so verdict logic stays the product's own.
  const decisions = (inner: DecisionProvider): DecisionProvider =>
    variant.id === "current" ? inner : new VariantDecisionProvider(inner, variant, caseForRun);
  let reviewer: AutoReviewProvider;
  try {
    if (isJev && variant.id !== "current") {
      return notRun(
        "Variants run through the decision protocol over OpenRouter or a catalog model",
      );
    } else if (isJev) {
      const { JevAutoReviewProvider } = await import(
        "../../../adapters/src/providers/decision/typesafe/jev-auto-review.ts"
      );
      reviewer = new JevAutoReviewProvider({
        apiKey,
        model: connection.modelId,
        callObserver,
        onUsage: async (usage) => record(usage),
      });
    } else if (protocol === "decisions") {
      const { HttpDecisionProvider } = await import(
        "../../../adapters/src/approvals/http-decisions.ts"
      );
      const { DecisionAutoReviewProvider } = await import(
        "../../../adapters/src/approvals/decision-auto-review.ts"
      );
      reviewer = new DecisionAutoReviewProvider({
        provider: decisions(
          new HttpDecisionProvider("openrouter", {
            apiKey,
            callObserver,
            onUsage: async (usage) => record(usage),
          }),
        ),
        providerId: connection.provider,
        model: connection.modelId,
      });
    } else {
      const { PiAgentRuntime } = await import("../../../adapters/src/runtime/pi/pi-runtime.ts");
      const llmOptions = {
        checker: { provider: connection.provider, model: connection.modelId },
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        headers: connection.headers,
        // The operator runs evals against the model server they chose, often on loopback.
        allowPrivateEndpoint: true,
        contextWindow: connection.contextWindow ?? undefined,
        maxTokens: connection.maxTokens ?? undefined,
        reasoning: connection.reasoning,
        onUsage: async (usage: Omit<MeasuredCall, "id"> & { callId?: string }) => record(usage),
        spaceId: "approval-eval-space",
        userId: "approval-eval-user",
        botId: "approval-eval-bot",
        threadId: "approval-eval-thread",
      };
      // The product's LLM review under each trial's own run id; a variant adds its rubric and
      // situation to the product's prompt on the way to the model.
      const runtime = new PiAgentRuntime({ modelCallObserver: callObserver });
      const variantRuntime: AgentRuntime = {
        describe: () => runtime.describe(),
        abort: (runId) => runtime.abort(runId),
        run: (request, context) => {
          const c = caseForRun(request.runId);
          if (!c) throw new Error("Approval variant has no case for this run");
          return runtime.run(
            { ...request, prompt: variantPrompt(request.prompt, c, variant, escapePromptData) },
            context,
          );
        },
      };
      reviewer = {
        describe: () => ({
          id: "llm",
          contractVersion: "1",
          adapterVersion: "0.1.0",
          capabilities: { offline: false, keyless: false },
        }),
        review: (request, context) =>
          new autoReview.LlmAutoReviewProvider({
            ...llmOptions,
            runtime: variantRuntime,
            runId: context.runId ?? "approval-eval",
          }).review(request, context),
      };
    }
  } catch {
    return notRun("The approval reviewer could not be constructed from this connection");
  }

  const secrets = [apiKey, connection.baseUrl ?? ""];
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    await runApprovalCases(selected, reviewer, {
      trials,
      timeoutMs,
      concurrency,
      pricing,
      drainCalls,
      shouldStop: () => stopRequested,
      onResult: (result) => {
        result.reason = result.reason === null ? null : redact(result.reason, secrets);
        results.push(result);
        save();
        console.log(
          `${result.caseId} trial ${result.trial}: expected ${result.expected}, got ${result.got} (${result.outcome}); ${result.latencyMs}ms`,
        );
      },
    });
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
  report.status = stopRequested ? "stopped" : "complete";
  save();
  const s = report.summary;
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  console.log(
    `agreement ${pct(s.agreementRate)}; false-ask ${pct(s.falseAskRate)}; false-pass ${pct(s.falsePassRate)}; unqualified ${s.unqualified}; reviewer cost ${s.costUsd === null ? "unknown" : `$${s.costUsd.toFixed(6)}`}`,
  );
  if (store && results.length) {
    const entry = store.save(storedApprovalRun(report, selected, values.label));
    console.log(`Stored run ${entry.fingerprint} (${entry.path})`);
  }
  if (stopRequested || s.agreed !== s.results) process.exitCode = 1;
}

/**
 * The report in the shape the run store indexes, fingerprinted by the cases, variant, reviewer and
 * code that produced it. Approval runs are never reused, so each trial carries only the fields the
 * index reads beside the approval result itself.
 */
function storedApprovalRun(
  report: {
    startedAt: string;
    fixtureVersion: string;
    variant: string;
    variantsVersion: string;
    rubricVersion: string | null;
    reviewer: { protocol: string; provider: string; model: string } | null;
    codeRevision: string | null;
    workingDiffHash: string | null;
    controls: { trials: number };
    results: ApprovalCaseResult[];
    summary: { costUsd: number | null };
  },
  cases: readonly ApprovalCase[],
  label: string | undefined,
): StoredReport {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const inputs = {
    variant: report.variant,
    variantsVersion: report.variantsVersion,
    rubricVersion: report.rubricVersion,
    reviewer: report.reviewer,
    codeRevision: report.codeRevision,
    workingDiffHash: report.workingDiffHash,
  };
  return {
    ...report,
    suite: label ? `approval:${label}` : "approval",
    model: report.reviewer?.model ?? null,
    provider: report.reviewer?.provider ?? null,
    judge: null,
    fingerprint: {
      run: hash({ suite: "approval", cases, trials: report.controls.trials, ...inputs }),
      cases: Object.fromEntries(cases.map((c) => [c.id, hash({ c, ...inputs })])),
    },
    workflowTotals: { costUsd: report.summary.costUsd },
    trials: report.results.map((r) => ({
      ...r,
      strategy: report.variant,
      status: r.outcome === "agree" ? "passed" : r.outcome === "unqualified" ? "not-run" : "failed",
      category: null,
      cleanupFailed: false,
    })) as unknown as TrialResult[],
  };
}
