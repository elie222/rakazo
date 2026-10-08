import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { EVAL_CASES, HISTORY_EVAL_CASES } from "../evals/cases.js";
import { HISTORY_FIXTURE_VERSION } from "../evals/history-fixtures.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "../evals/history-observer.js";
import { observeSyntheticHistory } from "../evals/history-observer.js";
import type { CacheDecisionMeasurement, EvalPricing } from "../evals/measurement.js";
import { measureCalls, SpendBudget, validatePricing } from "../evals/measurement.js";
import { emptyTrial, redact, summarize, validateControls } from "../evals/report.js";
import type { DiagnosticWireObservation } from "../evals/wire-observer.js";
import { installDiagnosticWireObserver } from "../evals/wire-observer.js";

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "product" },
      strategy: { type: "string", multiple: true },
      pricing: { type: "string" },
      "cache-probe": { type: "boolean", default: false },
      "cache-capabilities": { type: "string" },
      "spend-cap-usd": { type: "string", default: "5" },
      live: { type: "boolean", default: false },
      "stop-on-failure": { type: "boolean", default: false },
      "wire-diagnostics": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      connection: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      "base-url": { type: "string" },
      "context-window": { type: "string" },
      "max-output-tokens": { type: "string" },
      trials: { type: "string", default: "3" },
      case: { type: "string", multiple: true },
      "timeout-ms": { type: "string", default: "180000" },
      "max-tool-calls": { type: "string", default: "30" },
      output: { type: "string", default: "test-report/evals/report.json" },
    },
  });
  const cases =
    values.suite === "history" ? HISTORY_EVAL_CASES : values.suite === "product" ? EVAL_CASES : [];
  if (!cases.length) throw new Error("Unknown suite; use product or history");
  if (values["wire-diagnostics"] && values.suite !== "history")
    throw new Error("Synthetic wire diagnostics require the history suite");
  const strategies = [...new Set(values.strategy?.length ? values.strategy : ["current"])];
  if (
    strategies.some(
      (strategy) => !["current", "retrieval", "snapshots", "cache-aware"].includes(strategy),
    )
  )
    throw new Error("Unknown context strategy");
  if (values.list) {
    for (const scenario of cases) console.log(`${scenario.id}: ${scenario.purpose}`);
    return;
  }
  const controls = {
    trials: Number(values.trials),
    timeoutMs: Number(values["timeout-ms"]),
    maxToolCalls: Number(values["max-tool-calls"]),
  };
  validateControls(controls);
  const selected = values.case?.length ? cases.filter((c) => values.case!.includes(c.id)) : cases;
  if (!selected.length || values.case?.some((id) => !cases.some((c) => c.id === id)))
    throw new Error("Unknown eval case; use --list");
  const trials = selected
    .flatMap((c, caseIndex) =>
      Array.from({ length: controls.trials }, (_, i) =>
        strategies.map((_, position) => {
          const strategy = strategies[(position + caseIndex + i) % strategies.length]!;
          return { ...emptyTrial(c.id, i + 1), strategy };
        }),
      ),
    )
    .flat();
  const output = path.resolve(values.output!);
  let budget: SpendBudget | undefined;
  let probeTotals: { costUsd: number | null; modelCalls: number } | undefined;
  const report = {
    version: 2,
    kind: "real-model-product-eval",
    startedAt: new Date().toISOString(),
    model: values.model ?? process.env.PI_DEFAULT_MODEL ?? null,
    provider: values.provider ?? null,
    modelLimits: {
      contextWindow: values["context-window"] ? Number(values["context-window"]) : null,
      maxOutputTokens: values["max-output-tokens"] ? Number(values["max-output-tokens"]) : null,
    },
    controls,
    strategy: strategies.length === 1 ? strategies[0] : "comparison",
    strategies,
    executionOrder:
      "Rotate strategy order deterministically within each seeded case and trial; provider cache state is not controlled.",
    historyPreparation:
      values.suite === "history"
        ? "Short chats use originals. Larger ordinary cases use a synthetic prepared summary retaining common facts and omitting rare identifiers; backlog, failed-summary and oversized cases retain raw compaction stress."
        : null,
    fixtureVersion: values.suite === "history" ? HISTORY_FIXTURE_VERSION : "product-v1",
    caseFixtureVersions: Object.fromEntries(
      selected.map((c) => [
        c.id,
        c.history?.version ?? (values.suite === "history" ? HISTORY_FIXTURE_VERSION : "product-v1"),
      ]),
    ),
    codeRevision: codeRevision(),
    workingDiffHash: workingDiffHash(),
    promptOrder: "stable guidance before changing context",
    pricing: null as EvalPricing | null,
    spendCapUsd: Number(values["spend-cap-usd"]),
    workflowTotals: { modelCalls: 0, costUsd: null as number | null },
    guardAccounting: {
      settledUpperBoundUsd: null as number | null,
      reservedUsd: null as number | null,
    },
    costSource:
      "Per-call provider reported charge when available, otherwise explicit pricing estimate; unavailable remains null",
    firstResponseDefinition:
      "First persisted streamed text event after run creation, or final bot message if no text streamed; excludes activity/tool-only events. Polling does not define the timestamp.",
    fixtures: "synthetic services, messaging and fake sandbox",
    assistedRetries: false,
    limitations: [
      "Does not evaluate browser perception, native recording perception, or real external services.",
      "Release routine grades a scheduled new-release read; unchanged-release notification deduplication is not covered.",
      "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
      "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.",
      "Tool trace contains names and statuses only; raw requests and responses are omitted.",
    ],
    trials,
    summary: summarize(trials),
  };
  const save = () => {
    report.summary = summarize(report.trials);
    const attempted = trials.filter((trial) => trial.status !== "not-run");
    const costs = [
      ...attempted.map((trial) => trial.costUsd),
      ...(probeTotals ? [probeTotals.costUsd] : []),
    ];
    report.workflowTotals = {
      modelCalls:
        attempted.reduce((n, trial) => n + trial.modelCalls, 0) + (probeTotals?.modelCalls ?? 0),
      costUsd:
        costs.length && costs.every((cost) => cost !== null)
          ? costs.reduce<number>((n, cost) => n + cost!, 0)
          : null,
    };
    if (budget)
      report.guardAccounting = {
        settledUpperBoundUsd: budget.usedUsd,
        reservedUsd: budget.reservedUsd,
      };
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  save();
  const notRun = (reason: string): never => {
    for (const trial of trials) {
      trial.reason = reason;
      trial.category = "incomplete";
    }
    save();
    throw new Error(reason);
  };
  if (!values.live) notRun("Live model execution requires --live; report marks all trials not-run");
  loadRootEnv();
  const rawConnection: unknown = values.connection
    ? readConnection(values.connection)
    : {
        provider: values.provider,
        modelId: values.model ?? process.env.PI_DEFAULT_MODEL,
        apiKey: values["api-key-env"] ? process.env[values["api-key-env"]] : undefined,
        baseUrl: values["base-url"],
        cacheCapabilities: values["cache-capabilities"]
          ? readConnection(values["cache-capabilities"])
          : undefined,
        contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
        maxTokens: values["max-output-tokens"] ? Number(values["max-output-tokens"]) : undefined,
        label: "Eval model",
      };
  const parsedConnection = ModelConnectInputSchema.safeParse(rawConnection);
  if (!parsedConnection.success || !parsedConnection.data.modelId?.trim())
    return notRun(
      "A valid model connection is required: --connection with models/connect JSON, or --provider --model --api-key-env (and --base-url for compatible servers). All trials remain not-run.",
    );
  let pricing: EvalPricing;
  try {
    pricing = validatePricing(
      values.pricing ? JSON.parse(readFileSync(values.pricing, "utf8")) : null,
    );
  } catch {
    return notRun(
      "Live execution requires --pricing with explicit source, version and USD per million rates. All trials remain not-run.",
    );
  }
  report.pricing = pricing;
  budget = new SpendBudget(report.spendCapUsd, pricing);
  const liveBudget = budget;
  const connection = parsedConnection.data;
  report.model = connection.modelId!;
  report.provider = connection.provider;
  Object.assign(report, { cacheCapabilities: connection.cacheCapabilities ?? null });
  report.modelLimits = {
    contextWindow: connection.contextWindow ?? null,
    maxOutputTokens: connection.maxTokens ?? null,
  };
  save();
  if (values["cache-probe"]) {
    const { PiAgentRuntime } = await import("../../../adapters/src/pi-runtime.ts");
    const { runCachePrefixProbe } = await import("../evals/cache-probe.js");
    const decisions: CacheDecisionMeasurement[] = [];
    const runtime = new PiAgentRuntime({
      onContextDecision: (decision) => {
        const measured = measureCalls([{ id: "call", ...decision.usage }], pricing);
        decisions.push({
          predictedCache: decision.predictedCache,
          observedReuse: decision.observedReuse,
          estimatedInputTokens: decision.estimatedInputTokens,
          droppedMessages: decision.droppedMessages,
          truncatedToolResults: decision.truncatedToolResults,
          costUsd: measured.costUsd,
          cacheReadTokens: decision.usage.cacheReadTokens ?? null,
        });
      },
      modelCallObserver: {
        beforeCall: (call) => {
          if (call.provider !== connection.provider || call.modelId !== connection.modelId)
            throw new Error("Eval model has no configured pricing");
          return liveBudget.reserve(
            call.inputTokensEstimate,
            call.maxOutputTokens,
            call.cacheWriteRetention,
          );
        },
        afterCall: (id, usage) => liveBudget.settleUsage(id, usage),
      },
    });
    const probe = await runCachePrefixProbe(
      runtime,
      {
        ...connection,
        id: connection.modelId!,
        maxImagesPerPrompt: connection.maxImagesPerPrompt ?? undefined,
        maxTokens: connection.maxTokens ?? undefined,
      },
      pricing,
      decisions,
    );
    trials.length = 0;
    probeTotals = probe;
    Object.assign(report, {
      kind: "cache-prefix-probe",
      fixtureVersion: probe.fixtureVersion,
      caseFixtureVersions: {},
      modelLimits: probe.modelLimits,
      firstResponseDefinition:
        "First direct runtime text event after starting each probe call; no database or polling timestamps.",
      fixtures: "Direct synthetic prefixes; no database, service emulators, or tools.",
      limitations: [
        "Four direct synthetic model calls; does not evaluate product workflows, database persistence, or tools.",
        "Immediate replay measures observed warm versus fresh changed-prefix reuse; provider routing and eviction are uncontrolled, live expiry is not tested, and four calls are not a reliability estimate.",
        "Cost uses provider-reported charges where available and explicit pricing estimates otherwise; spend reservations are a guard, not a billing guarantee.",
      ],
      cacheProbe: probe,
    });
    for (const key of [
      "controls",
      "executionOrder",
      "historyPreparation",
      "promptOrder",
      "assistedRetries",
    ])
      Reflect.deleteProperty(report, key);
    save();
    if (probe.phases.some((phase) => phase.failed)) process.exitCode = 1;
    return;
  }
  // This CLI owns a disposable database. Never migrate or evaluate against an inherited database.
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-evals-"));
  let postgres: StartedPostgreSqlContainer | undefined;
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      REALTIME_DATABASE_URL: databaseUrl,
      WAKEUP_DRIVER: "memory",
      BETTER_AUTH_SECRET: "synthetic-eval-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "synthetic-eval-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "synthetic-eval-supervisor-token-at-least-32-characters",
      SCREEN_PROXY_SECRET: "synthetic-eval-screen-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      SANDBOX_PROVIDER: "fake",
      AGENT_RUNTIME: "pi",
      DATA_DIR: dataDir,
      MAX_TOOL_CALLS_PER_TURN: String(controls.maxToolCalls),
      WEB_PROVIDER: "fake",
      LOG_LEVEL: "off",
      COMPOSIO_API_KEY: "",
      PIPEDREAM_CLIENT_ID: "",
      PIPEDREAM_CLIENT_SECRET: "",
      PIPEDREAM_PROJECT_ID: "",
      SMTP_URL: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      WHATSAPP_ACCESS_TOKEN: "",
      LARK_APP_ID: "",
      SENDBLUE_API_KEY_ID: "",
      CURSOR_API_KEY: "",
      CLOUD_AGENT_PROVIDER: "",
      MODEL_API_KEY: "",
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    // Import runtime modules only after generation; their barrel exports load Prisma.
    const { createApp } = await import("../../../../apps/api/src/app.ts");
    const { runTrial } = await import("../evals/runner.js");
    const { PiAgentRuntime } = await import("@rakazo/adapters");
    const { EvalSandboxProvider } = await import("../evals/sandbox.js");
    for (let i = 0; i < trials.length; i++) {
      if (stopRequested) {
        for (const remaining of trials.slice(i))
          remaining.reason =
            "Not run because graceful stop was requested; the in-flight workflow drained before scheduling stopped";
        Object.assign(report, { termination: "graceful-stop-after-workflow" });
        save();
        process.exitCode = 130;
        break;
      }
      const planned = trials[i]!;
      const scenario = selected.find((c) => c.id === planned.caseId)!;
      const wireDiagnostics: DiagnosticWireObservation[] = [];
      const observeWire =
        values["wire-diagnostics"] &&
        (scenario.id === "history-1000-long-tool-loop" ||
          scenario.id === "history-10000-long-tool-loop");
      const restoreFetch = observeWire
        ? installDiagnosticWireObserver(connection.modelId!, wireDiagnostics)
        : () => {};
      try {
        trials[i] = {
          ...(await runTrial(scenario, planned.trial, {
            ...controls,
            connection,
            pricing,
            createApp: async (composio, messaging) => {
              const sandbox = new EvalSandboxProvider();
              let acceptingCalls = true;
              const cacheDecisions: CacheDecisionMeasurement[] = [];
              const runtime = new PiAgentRuntime({
                onContextDecision: (decision) => {
                  const measured = measureCalls([{ id: "call", ...decision.usage }], pricing);
                  cacheDecisions.push({
                    predictedCache: decision.predictedCache,
                    observedReuse: decision.observedReuse,
                    estimatedInputTokens: decision.estimatedInputTokens,
                    droppedMessages: decision.droppedMessages,
                    truncatedToolResults: decision.truncatedToolResults,
                    costUsd: measured.costUsd,
                    cacheReadTokens: decision.usage.cacheReadTokens ?? null,
                  });
                },
                modelCallObserver: {
                  beforeCall: ({
                    inputTokensEstimate,
                    maxOutputTokens,
                    provider,
                    modelId,
                    cacheWriteRetention,
                  }) => {
                    if (provider !== connection.provider || modelId !== connection.modelId)
                      throw new Error("Eval model has no configured pricing");
                    if (!acceptingCalls) throw new Error("Eval trial stopped scheduling inference");
                    return liveBudget.reserve(
                      inputTokensEstimate,
                      maxOutputTokens,
                      cacheWriteRetention,
                    );
                  },
                  afterCall: (id, usage) => liveBudget.settleUsage(id, usage),
                },
              });
              const historyDiagnostics: HistoryDiagnostic[] = [];
              const toolLoopDiagnostics: DiagnosticToolObservation[] = [];
              const observedRuntime = observeSyntheticHistory(
                runtime,
                historyDiagnostics,
                [connection.apiKey ?? "", connection.baseUrl ?? ""],
                toolLoopDiagnostics,
              );
              const handles = await createApp({
                runtime: observedRuntime,
                contextStrategy: planned.strategy as
                  | "current"
                  | "retrieval"
                  | "snapshots"
                  | "cache-aware",
                sandbox,
                databaseUrl,
                realtimeDatabaseUrl: databaseUrl,
                dataDir: path.join(dataDir, `${scenario.id}-${planned.strategy}-${planned.trial}`),
                sandboxProvider: "fake",
                agentRuntime: "pi",
                wakeupDriver: "memory",
                composio,
                messaging,
                messagingOpenSignup: false,
                defaultProvider: connection.provider,
                defaultModel: connection.modelId!,
                deploymentModelKey: undefined,
                composioApiKey: undefined,
                cursorApiKey: undefined,
                cloudAgentProvider: "none",
                signupsEnabled: "true",
                signupAllowlist: "",
                emailEmulator: true,
                pipedreamClientId: undefined,
                pipedreamClientSecret: undefined,
                pipedreamProjectId: undefined,
                smtpUrl: undefined,
                emailFrom: undefined,
                sendblueApiKeyId: undefined,
                sendblueApiSecret: undefined,
                slackBotToken: undefined,
                whatsappAccessToken: undefined,
                telegramBotToken: undefined,
                larkAppId: undefined,
                mcpStdioEnabled: false,
                mcpStdioAllowedCommands: [],
                updaterUrl: undefined,
                updaterToken: undefined,
              });
              return {
                ...handles,
                harnessIssues: sandbox.harnessIssues,
                cacheDecisions,
                historyDiagnostics,
                toolLoopDiagnostics,
                finalizeBackground: async () => {
                  acceptingCalls = false;
                  await handles.jobs.close();
                },
                stop: async () => {
                  acceptingCalls = false;
                  await handles.stop();
                },
                awaitIdle: async () => {
                  if (!handles.awaitIdle) throw new Error("Eval queue cannot await idle");
                  await handles.awaitIdle();
                },
              };
            },
          })),
          strategy: planned.strategy,
          ...(observeWire ? { wireDiagnostics } : {}),
        };
      } finally {
        restoreFetch();
      }
      save();
      const result = trials[i]!;
      console.log(
        `${result.caseId} ${result.strategy} trial ${result.trial}: ${result.status}${result.category ? ` (${result.category})` : ""}; ${result.toolCalls} tool calls; ${result.latencyMs}ms`,
      );
      if (values["stop-on-failure"] && result.status === "failed") {
        for (const remaining of trials.slice(i + 1))
          remaining.reason = "Not run because stop-on-failure ended the bounded diagnostic";
        save();
        process.exitCode = 1;
        break;
      }
      if (result.cleanupFailed || /spend cap|no configured pricing/i.test(result.reason ?? "")) {
        for (const remaining of trials.slice(i + 1))
          remaining.reason = result.cleanupFailed
            ? "Not run because fixture cleanup failed"
            : "Not run because the shared comparison spend cap or pricing guard stopped scheduling";
        save();
        process.exitCode = 1;
        break;
      }
    }
    if (trials.some((r) => r.status !== "passed")) process.exitCode = 1;
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    try {
      await postgres?.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

function workingDiffHash(): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const options = {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    };
    const hash = createHash("sha256").update(execFileSync("git", ["diff", "HEAD"], options));
    const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      ...options,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => /\.(?:ts|tsx|json)$/.test(p) && /^(?:packages|apps)\//.test(p))
      .sort();
    for (const file of added) hash.update(file).update(readFileSync(path.join(root, file)));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function codeRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readConnection(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Parser and filesystem errors may include private file contents or paths.
    throw new Error(
      "Could not read model connection JSON. Check that the file is readable and contains valid JSON. All trials remain not-run.",
    );
  }
}

main().catch((error: unknown) => {
  // Never dump process env, subprocess output, connection JSON, or error stacks into public CI logs.
  console.error(
    redact(
      error instanceof Error ? error.message.split("\n")[0]! : "Eval runner failed",
      Object.entries(process.env)
        .filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD/.test(key))
        .map(([, value]) => value ?? ""),
    ),
  );
  process.exitCode = 1;
});
