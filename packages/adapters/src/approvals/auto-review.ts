import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunModel,
  AgentRuntime,
  AgentRuntimeEvent,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
  CacheCapabilities,
} from "@rakazo/adapter-kit";
import type { AutoReviewJudgeDecision } from "@rakazo/core";
import { redactSecrets } from "@rakazo/core";
import { sitesInText } from "@rakazo/core/egress";
import { z } from "zod";
import { resolveDeploymentModel } from "../models/deployment-model.js";
import { parseModelJson } from "../models/model-json.js";
import { secretValuesToRedact } from "../models/model-secret.js";
import { LOCAL_PROVIDER_ID } from "../runtime/pi/models/pi-local-provider.js";
import { localModelIds } from "../runtime/pi/models/pi-local-provider-id.js";
import {
  autoReviewInstructions,
  buildAutoReviewPrompt,
  truncateReviewText,
} from "./auto-review.prompt.js";
import { decisionModel, includedDecisionModel } from "./decision-models.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ARGS_CHARS = 8_000;
const MAX_REASON_CHARS = 160;
const SENSITIVE_REVIEW_ARG_KEY =
  /password|secret|token|api[_-]?key|authorization|cookie|credential/i;

export type AutoReviewChecker = {
  provider: string;
  model: string;
  /** The effort saved with this approval choice; the model's default when unset. */
  thinkingLevel?: AgentRunModel["thinkingLevel"];
  /** The connection the approval choice is pinned to. */
  credentialId?: string;
  creditOfferingId?: string;
  /** The deployment's operator-funded reviewer, added last so a member's unusable choice still gets a decision. */
  included?: true;
};

export type AutoReviewJudgeResult = AutoReviewResult;

export type AutoReviewProviderKind = "llm" | "jev" | "scripted";

export const JEV_AUTO_REVIEW_PROVIDER = "jev";
export const SCRIPTED_AUTO_REVIEW_PROVIDER = "scripted";
export const DEFAULT_JEV_MODEL = "jev-latest";

export function autoReviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RAKAZO_AUTO_REVIEW_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 200 || value > 30_000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(value);
}

/** TypeSafe Jev key. Optional; core Auto Review still uses the LLM checker without it. */
export function typesafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.TYPESAFE_API_KEY?.trim();
  return value || undefined;
}

/**
 * The operator's confidence floor for every decision model; unset, each model's calibration decides.
 * An unreadable value throws rather than falling back, since a typo would quietly loosen the floor.
 */
export function autoReviewMinConfidence(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE must be a number from 0 to 1");
  return value;
}

function isVerifierKind(value: string | undefined): value is "jev" | "scripted" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "jev" || normalized === "scripted";
}

/**
 * `RAKAZO_AUTO_REVIEW_PROVIDER=jev` selects TypeSafe Jev when a key is present;
 * otherwise the existing LLM checker. `scripted` is the offline test adapter.
 * Any other value remains the LLM provider id (openrouter, anthropic, …).
 */
export function resolveAutoReviewProviderKind(
  env: NodeJS.ProcessEnv = process.env,
): AutoReviewProviderKind {
  const requested = env.RAKAZO_AUTO_REVIEW_PROVIDER?.trim().toLowerCase();
  if (requested === "jev") return typesafeApiKey(env) ? "jev" : "llm";
  if (requested === "scripted" && env.AGENT_RUNTIME === "scripted") return "scripted";
  return "llm";
}

/**
 * Prefer explicit env overrides, then local models, then PI_DEFAULT_*.
 * Returns null only when there is no model id to try.
 */
export function resolveAutoReviewChecker(
  env: NodeJS.ProcessEnv = process.env,
  included = false,
): AutoReviewChecker | null {
  const kind = resolveAutoReviewProviderKind(env);
  if (kind === "jev") {
    return {
      provider: JEV_AUTO_REVIEW_PROVIDER,
      model: env.RAKAZO_AUTO_REVIEW_MODEL?.trim() || DEFAULT_JEV_MODEL,
    };
  }
  if (kind === "scripted") {
    return { provider: SCRIPTED_AUTO_REVIEW_PROVIDER, model: "scripted" };
  }

  const overrideProvider = env.RAKAZO_AUTO_REVIEW_PROVIDER?.trim();
  const overrideModel = env.RAKAZO_AUTO_REVIEW_MODEL?.trim();
  if (overrideProvider && overrideModel && !isVerifierKind(overrideProvider)) {
    return { provider: overrideProvider, model: overrideModel };
  }

  if (included && !overrideProvider && !overrideModel) {
    const model = includedDecisionModel(env);
    if (model) return { provider: model.provider, model: model.id };
  }

  const localIds = localModelIds(env);
  if (localIds[0]) {
    return { provider: LOCAL_PROVIDER_ID, model: localIds[0]! };
  }

  const deployment = resolveDeploymentModel(env);
  if (!deployment.model) return null;
  return { provider: deployment.provider, model: deployment.model };
}

/**
 * The deployment's operator-funded reviewer, when hosted credits include one. It is what a
 * member who chose no approval model runs, and needs no connection or credits of theirs.
 */
export function includedReviewChecker(
  creditsEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AutoReviewChecker | null {
  if (!creditsEnabled) return null;
  const checker = resolveAutoReviewChecker(env, true);
  if (
    !checker ||
    !decisionModel(checker.provider, checker.model) ||
    !isAutoReviewCheckerConfigured({ env, checker })
  )
    return null;
  return { ...checker, included: true };
}

/**
 * Whether the deployment pays for its default reviewer, as runs fund it for a member who chose
 * no approval model: with hosted credits on, a configured decision model or verifier.
 */
export function deploymentPaysForReview(
  checker: AutoReviewChecker,
  creditsEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    creditsEnabled &&
    (Boolean(decisionModel(checker.provider, checker.model)) ||
      checker.provider === JEV_AUTO_REVIEW_PROVIDER ||
      checker.provider === SCRIPTED_AUTO_REVIEW_PROVIDER) &&
    isAutoReviewCheckerConfigured({ env, checker })
  );
}

/**
 * Whether the checker can actually run without a hosted vendor being required for core.
 * Local models count; otherwise the checker provider needs a deployment key or a user key.
 */
export function isAutoReviewCheckerConfigured(input: {
  env?: NodeJS.ProcessEnv;
  checker?: AutoReviewChecker;
  hasUserCredentialForProvider?: (provider: string) => boolean;
}): boolean {
  const env = input.env ?? process.env;
  const checker = input.checker ?? resolveAutoReviewChecker(env);
  if (!checker) return false;
  if (checker.provider === JEV_AUTO_REVIEW_PROVIDER) return Boolean(typesafeApiKey(env));
  if (checker.provider === SCRIPTED_AUTO_REVIEW_PROVIDER) return true;
  if (checker.provider === LOCAL_PROVIDER_ID) return localModelIds(env).length > 0;

  const decision = decisionModel(checker.provider, checker.model);
  if (decision?.deploymentApiKey(env)) return true;
  const deployment = resolveDeploymentModel(env);
  if (checker.provider === deployment.provider && deployment.configured) return true;
  if (env.OPENROUTER_API_KEY?.trim() && checker.provider === "openrouter") return true;
  if (env.ANTHROPIC_API_KEY?.trim() && checker.provider === "anthropic") return true;
  return Boolean(input.hasUserCredentialForProvider?.(checker.provider));
}

export function redactToolArgsForReview(
  args: Record<string, unknown>,
  secrets: string[],
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const redactedKey = redactSecrets(key, secrets);
    if (SENSITIVE_REVIEW_ARG_KEY.test(key)) {
      redacted[redactedKey] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      redacted[redactedKey] = redactSecrets(value, secrets);
      continue;
    }
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      redacted[redactedKey] = value;
      continue;
    }
    try {
      const serialized = JSON.stringify(value);
      redacted[redactedKey] =
        serialized === undefined
          ? "[unserializable]"
          : redactNestedReviewValue(JSON.parse(serialized), secrets);
    } catch {
      redacted[redactedKey] = "[unserializable]";
    }
  }
  return redacted;
}

function redactNestedReviewValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedReviewValue(item, secrets));
  }
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      redactSecrets(key, secrets),
      SENSITIVE_REVIEW_ARG_KEY.test(key)
        ? "[redacted]"
        : redactNestedReviewValue(nestedValue, secrets),
    ]),
  );
}

/**
 * A longer command reaches the reviewer as its start and end, which hold what it runs and usually
 * where it sends, plus every address named in the part left out, so a cut never hides where data
 * goes. The bound keeps the review fast and under the reviewer's argument limit.
 */
export const MAX_REVIEW_COMMAND_CHARS = 6_000;
const COMMAND_HEAD_CHARS = 4_200;
const COMMAND_TAIL_CHARS = 1_600;
const MAX_LEFT_OUT_ADDRESSES = 20;
/** Room for a cut command once serialized, under the reviewer's argument limit. */
const MAX_REVIEWED_COMMAND_ARGS = 7_500;
/** Below this the cut stops shrinking; what is left asks as too long to review. */
const MIN_SHOWN_COMMAND_CHARS = 400;
const MAX_ADDRESS_CHARS = 200;

/** Shell words split here; `=` too, so `--url=https://…` yields the URL and a query keeps its host. */
const WORD_SEPARATORS = /[\s<>"'`|;&()=,]+/;
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Mail, ssh, scp and git name a host after `@`. */
const USER_AT_HOST_WORD = /^[^@]+@[^@]+$/;
/** A whole word that is an IPv4 address, with an optional port and path; `10.0.0.1.sink.example` is a host. */
const IPV4_WORD = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?$/;
const MAX_HOST_CHARS = 253;
/**
 * An IPv6 address, bracketed or bare: eight hex groups, or fewer around one `::`. Clock times and
 * MAC addresses have neither shape.
 */
const IPV6_WORD =
  /^\[?(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)\]?(?::\d+)?$/i;

/**
 * The addresses a piece of a command names: URLs of any scheme, `user@host`, IPv4 addresses and
 * bare host names on a known suffix (`nc collect.example.net 443`, `dig`). Read one word at a time
 * with anchored patterns, so a long command is read in linear time; each is cut short enough to
 * keep its host.
 */
function addressesIn(text: string, shown: string): string[] | undefined {
  // Whole words only: a look-alike in the shown part must not hide an address left out.
  const shownWords = new Set(shown.split(WORD_SEPARATORS));
  const found = new Set<string>();
  // Bare names are listed but never decide the cut: code and file names (`setup.py`,
  // `self.name`) read as host names too, and a long heredoc holds many.
  const names = new Set<string>();
  for (const word of text.split(WORD_SEPARATORS)) {
    // More than the list holds could hide the one that matters behind decoys.
    if (found.size > MAX_LEFT_OUT_ADDRESSES) return undefined;
    // One the reviewer already sees whole in the start or end was not left out.
    if (!word || shownWords.has(word)) continue;
    if (
      URL_WORD.test(word) ||
      USER_AT_HOST_WORD.test(word) ||
      IPV4_WORD.test(word) ||
      (IPV6_WORD.test(word) && /[0-9a-f]/i.test(word))
    )
      found.add(word);
    else {
      // `$(…).sink.example.net` leaves a word that starts with a dot.
      const host = word.replace(/^\.+/, "");
      if (host.includes(".") && host.length <= MAX_HOST_CHARS && sitesInText(host).size)
        names.add(host);
    }
  }
  if (found.size > MAX_LEFT_OUT_ADDRESSES) return undefined;
  const room = MAX_LEFT_OUT_ADDRESSES - found.size;
  const listed = [...found, ...[...names].slice(0, room)].map(shortAddress);
  return names.size > room ? [...listed, `…and ${names.size - room} more names`] : listed;
}

/** An address cut short enough to list, always keeping where it goes: its host, after any user. */
function shortAddress(address: string): string {
  if (address.length <= MAX_ADDRESS_CHARS) return address;
  const scheme = URL_WORD.exec(address)?.[0] ?? "";
  const rest = address.slice(scheme.length);
  const authority = rest.split(/[/?#]/, 1)[0]!;
  const host = authority.slice(authority.lastIndexOf("@") + 1).slice(0, MAX_HOST_CHARS);
  return `${scheme}${authority.includes("@") ? "…@" : ""}${host}…`;
}

// Beside the computer reshaping below, for the eval CLI, which reads the review args from here.
export { changedTextReviewArgs } from "./changed-text-review-args.js";

/**
 * What Auto Review sees of a call on the bot's own computer, from arguments already redacted for
 * review: a browser action also names the page it acts on (`pageUrl`, the browser's own report),
 * since the refs it presses mean nothing without it.
 */
export function ownComputerReviewArgs(
  toolName: string,
  args: Record<string, unknown>,
  pageUrl: string | undefined,
): Record<string, unknown> {
  if (toolName === "browser_act") {
    // Only the browser says which page this is: a page the model wrote into its call is dropped.
    const { page: _claimed, ...rest } = args;
    const page = pageUrl && URL.canParse(pageUrl) ? new URL(pageUrl).origin : undefined;
    return page && page !== "null" ? { ...rest, page } : rest;
  }
  // The shell also runs a command given as `cmd`; the review shows it as `command` either way.
  const given = toolName === "shell" ? (args.command ?? args.cmd) : undefined;
  if (typeof given !== "string") return args;
  const { cmd: _alias, ...named } = args;
  const shellArgs = { ...named, command: given };
  const command = given;
  const fits = (value: Record<string, unknown>) =>
    JSON.stringify(value).length <= MAX_REVIEWED_COMMAND_ARGS;
  if (command.length <= MAX_REVIEW_COMMAND_CHARS && fits(shellArgs)) return shellArgs;
  // Quotes and newlines grow when the arguments are serialized, so the cut shrinks until it fits.
  for (let head = COMMAND_HEAD_CHARS, tail = COMMAND_TAIL_CHARS; ; ) {
    // Read past both cuts, so an address split by one still shows its host.
    const addresses = addressesIn(
      command.slice(
        Math.max(0, head - MAX_ADDRESS_CHARS),
        command.length - tail + MAX_ADDRESS_CHARS,
      ),
      `${command.slice(0, head)}\n${command.slice(command.length - tail)}`,
    );
    // Too many to list: the whole command goes, and one too long to review asks.
    if (!addresses) return shellArgs;
    const reviewed = {
      ...shellArgs,
      command: `${command.slice(0, head)}\n…[${command.length - head - tail} characters left out]…\n${command.slice(command.length - tail)}`,
      ...(addresses.length ? { addressesInPartLeftOut: addresses } : {}),
    };
    if (fits(reviewed) || head + tail < MIN_SHOWN_COMMAND_CHARS) return reviewed;
    head = Math.floor(head * 0.7);
    tail = Math.floor(tail * 0.7);
  }
}

/**
 * Arguments the checker cannot see in full are not reviewed: a cut would hide later
 * actions in a batch call, so these always ask the owner.
 */
export function reviewArgsTooLong(request: AutoReviewRequest): boolean {
  if (request.newSite) return false;
  try {
    return (JSON.stringify(request.args)?.length ?? 0) > MAX_ARGS_CHARS;
  } catch {
    return true;
  }
}

export const TOO_LONG_TO_REVIEW = "Too long to review.";

export function sanitizeAutoReviewReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const cleaned = reason
    .replace(/\u2014|\u2013/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return truncateReviewText(cleaned, MAX_REASON_CHARS);
}

const AutoReviewVerdict = z.object({
  decision: z.enum(["pass", "ask"]),
  reason: z.string().optional().catch(undefined),
});

/**
 * A verdict counts only when the whole reply is one JSON object, optionally in one code fence,
 * with no repeated keys. Anything else that still reads as a verdict becomes "ask", so prose, a
 * second object, or repaired syntax can never pass an action; an unreadable reply is "error".
 */
export function parseAutoReviewJudgeText(text: string): {
  decision: AutoReviewJudgeDecision;
  reason?: string;
} {
  const verdict = readStrictVerdict(text);
  if (verdict) {
    return {
      decision: verdict.decision,
      reason: verdict.reason === undefined ? undefined : sanitizeAutoReviewReason(verdict.reason),
    };
  }
  const loose = parseModelJson(text, AutoReviewVerdict);
  if (!loose) return { decision: "error" };
  if (loose.decision !== "ask" || loose.reason === undefined) return { decision: "ask" };
  return { decision: "ask", reason: sanitizeAutoReviewReason(loose.reason) };
}

function readStrictVerdict(text: string): z.infer<typeof AutoReviewVerdict> | undefined {
  const trimmed = text.trim();
  const body = /^```(?:json)?[ \t]*\r?\n([\s\S]*)```$/i.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (!body.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (hasRepeatedTopLevelKey(body)) return undefined;
    const result = AutoReviewVerdict.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** JSON.parse keeps the last of repeated keys; call only on text it has already accepted. */
function hasRepeatedTopLevelKey(json: string): boolean {
  const keys = new Set<string>();
  const colon = /\s*:/y;
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') {
      const start = i;
      for (i++; json[i] !== '"'; i++) if (json[i] === "\\") i++;
      colon.lastIndex = i + 1;
      if (depth === 1 && colon.test(json)) {
        const key: string = JSON.parse(json.slice(start, i + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return false;
}

export async function runAutoReviewJudge(
  input: LlmAutoReviewOptions & {
    prompt: string;
    signal?: AbortSignal;
  },
): Promise<AutoReviewJudgeResult> {
  const modelLabel = `${input.checker.provider}/${input.checker.model}`;
  const timeoutMs = input.timeoutMs ?? autoReviewTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  for (let attempt = 0; ; attempt++) {
    let text = "";
    let failed = false;
    try {
      for await (const event of input.runtime.run(
        {
          botId: input.botId,
          threadId: input.threadId,
          runId: `${input.runId}:auto-review`,
          usageOperationKind: "setup",
          onUsage: async (event) => {
            await input.onUsage?.(event);
          },
          prompt: input.prompt,
          instructions: autoReviewInstructions(),
          history: [],
          tools: [],
          model: {
            provider: input.checker.provider,
            id: input.checker.model,
            apiKey: input.oauth ? undefined : input.apiKey,
            accountId: input.accountId,
            gatewayId: input.gatewayId,
            projectId: input.projectId,
            region: input.region,
            zeroDataRetention: input.zeroDataRetention,
            baseUrl: input.baseUrl,
            headers: input.headers,
            allowPrivateEndpoint: input.allowPrivateEndpoint,
            cacheCapabilities: input.cacheCapabilities,
            contextWindow: input.contextWindow,
            maxTokens: input.maxTokens,
            reasoning: input.reasoning,
            thinkingLevel: input.checker.thinkingLevel ?? null,
            oauth: input.oauth,
            callObserver: input.callObserver,
            billing: input.billing,
          },
        },
        {
          operationId: `auto-review:${input.runId}`,
          traceId: `auto-review:${input.runId}`,
          spaceId: input.spaceId,
          userId: input.userId,
          signal,
        },
      )) {
        if (event.type === "usage" && !event.accounted) await input.onUsage?.(event);
        if (
          event.type === "text" &&
          /^(?:I hit a problem:|Unknown model )/i.test(event.text.trim())
        ) {
          failed = true;
        }
        if (event.type === "done" && event.text) {
          const body = event.text.trim();
          if (/^(?:I hit a problem:|Unknown model )/i.test(body)) failed = true;
          else text = body;
        }
      }
    } catch (error) {
      const timedOut =
        timeoutSignal.aborted ||
        (input.signal?.aborted === true &&
          (input.signal.reason instanceof DOMException || input.signal.reason instanceof Error) &&
          input.signal.reason.name === "TimeoutError");
      const secrets = secretValuesToRedact({
        kind: "openai_compatible",
        baseUrl: input.baseUrl ?? "",
        apiKey: input.apiKey,
        headers: input.headers,
      });
      const detail = timedOut
        ? timeoutSignal.aborted
          ? `timed out after ${timeoutMs}ms`
          : "timed out (parent deadline)"
        : `failed: ${truncateReviewText(
            redactSecrets(
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              secrets,
            ),
            200,
          )}`;
      // biome-ignore lint/suspicious/noConsole: Emit one sanitized checker diagnostic.
      console.warn(`[auto-review] checker ${redactSecrets(modelLabel, secrets)} ${detail}`);
      return {
        decision: "error",
        model: modelLabel,
        reason: timedOut ? "Checker timed out." : "Checker failed.",
      };
    }

    if (failed || !text) {
      return { decision: "error", model: modelLabel, reason: "Checker returned no decision." };
    }
    const parsed = parseAutoReviewJudgeText(text);
    // An unreadable verdict gets one more try before the owner is asked.
    if (parsed.decision === "error" && attempt === 0) continue;
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      model: modelLabel,
    };
  }
}

export type LlmAutoReviewOptions = {
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
  runtime: AgentRuntime;
  checker: AutoReviewChecker;
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  projectId?: string;
  region?: string;
  zeroDataRetention?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  allowPrivateEndpoint?: boolean;
  cacheCapabilities?: CacheCapabilities;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  oauth?: AgentRunModel["oauth"];
  callObserver?: AgentRunModel["callObserver"];
  billing?: AgentRunModel["billing"];
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  timeoutMs?: number;
};

/** JSON-text LLM checker, behind the same Auto Review interface as Jev. */
export class LlmAutoReviewProvider implements AutoReviewProvider {
  constructor(private readonly options: LlmAutoReviewOptions) {}

  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: "llm",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, keyless: false },
    };
  }

  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    if (reviewArgsTooLong(request)) {
      return {
        decision: "ask",
        model: `${this.options.checker.provider}/${this.options.checker.model}`,
        reason: TOO_LONG_TO_REVIEW,
      };
    }
    return runAutoReviewJudge({
      ...this.options,
      prompt: buildAutoReviewPrompt(request),
      signal: context.signal,
    });
  }
}
