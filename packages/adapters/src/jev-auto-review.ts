import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import {
  autoReviewMinConfidence,
  autoReviewTimeoutMs,
  DEFAULT_JEV_MODEL,
  sanitizeAutoReviewReason,
} from "./auto-review.js";
import { readBodyCapped } from "./web-ssrf.js";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_JSON_BYTES = 64_000;
const MAX_TASK_CHARS = 400;
const MAX_BOT_CHARS = 240;
const MAX_ARGS_CHARS = 1_200;

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    decision: choiceAnswerSchema,
  }),
});

export interface JevAutoReviewOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  minConfidence?: number;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function boundArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined && serialized.length <= MAX_ARGS_CHARS) return args;
    return { _truncated: truncate(serialized ?? "", MAX_ARGS_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

function errorResult(model: string, reason: string): AutoReviewResult {
  return {
    decision: "error",
    reason: sanitizeAutoReviewReason(reason),
    model,
  };
}

/** TypeSafe Jev over HTTP. No SDK. Failures map to the existing Auto Review error decision. */
export class JevAutoReviewProvider implements AutoReviewProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly minConfidence: number;

  constructor(options: JevAutoReviewOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? autoReviewTimeoutMs();
    this.model = options.model?.trim() || DEFAULT_JEV_MODEL;
    this.minConfidence = options.minConfidence ?? autoReviewMinConfidence();
  }

  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: "jev",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, keyless: false },
    };
  }

  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    const modelLabel = `jev/${this.model}`;
    const boundedSignal = AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImpl(JEV_URL, {
        method: "POST",
        redirect: "error",
        signal: boundedSignal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          state: {
            toolName: request.toolName,
            connectorKind: request.connectorKind,
            args: boundArgs(request.args),
            userTask: truncate(request.userTask, MAX_TASK_CHARS),
            botDescription: truncate(request.botDescription, MAX_BOT_CHARS),
            matchingRules: request.matchingRules.map((rule) => ({
              effect: rule.effect,
              matchKind: rule.matchKind,
              matchValue: rule.matchValue,
            })),
          },
          questions: {
            decision: {
              type: "choice",
              instructions: "Should this bot tool call auto-pass or ask the user to approve?",
              criteria: {
                pass: "Clearly fits the user task and looks low risk",
                ask: "Unexpected, high risk, or outside the task. Ask the user",
              },
            },
          },
        }),
      });
    } catch {
      return errorResult(modelLabel, "Checker timed out or failed.");
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return errorResult(modelLabel, reasonForStatus(response.status));
    }

    let parsed: unknown;
    try {
      const bytes = await readBodyCapped(response, MAX_JSON_BYTES, boundedSignal);
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return errorResult(modelLabel, "Checker returned no decision.");
    }

    const body = jevResponseSchema.safeParse(parsed);
    if (!body.success) return errorResult(modelLabel, "Checker returned no decision.");

    const answer = body.data.answers.decision;
    const model = body.data.model ? `jev/${body.data.model}` : modelLabel;
    if (answer.choice === "ask") {
      return { decision: "ask", model };
    }
    if (answer.choice === "pass") {
      if (typeof answer.confidence !== "number" || answer.confidence < this.minConfidence) {
        return {
          decision: "ask",
          reason: sanitizeAutoReviewReason("Checker is unsure."),
          model,
        };
      }
      return { decision: "pass", model };
    }
    return errorResult(model, "Checker returned no decision.");
  }
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return "Checker could not authenticate.";
  if (status === 422) return "Checker request was invalid.";
  if (status === 429 || status === 529) return "Checker is busy.";
  return "Checker timed out or failed.";
}
