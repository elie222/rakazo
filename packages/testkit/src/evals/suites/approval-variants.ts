import type {
  AdapterContext,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
} from "@rakazo/adapter-kit";
import { lastingWriteKind } from "@rakazo/core";
import type { ApprovalCase } from "./approval.js";
import {
  EARLIER_STEPS_NOTE,
  LEAN_ASK_CRITERIA,
  SOFT_DETAILS_CRITERIA,
  STATE_IS_DATA,
  variantPrompt,
} from "./approval-variants.prompt.js";

/**
 * Eval-only reviewer inputs and rubrics, so the same reviewed cases can be scored under each.
 * Nothing here runs in the product: a variant that wins is promoted by adding its input to the
 * product's review request or its wording to the product's rubric.
 *
 * A variant is `current` or `+`-joined parts:
 * - `steps`: what the bot did or read earlier in the run, raw where the case has it, outside text
 *   marked.
 * - `lean-ask` or `soft-details`: one rubric in place of the product's general one.
 */
/** Bump when a part's wording or inputs change, so runs of different wordings are never compared as one. */
export const APPROVAL_VARIANTS_VERSION = "approval-variants-v11";
export const APPROVAL_VARIANT_PARTS = ["steps", "lean-ask", "soft-details"] as const;
export type ApprovalVariantPart = (typeof APPROVAL_VARIANT_PARTS)[number];
export type ApprovalVariant = { id: string; parts: ReadonlySet<ApprovalVariantPart> };

const RUBRICS: Partial<Record<ApprovalVariantPart, { pass: string; ask: string }>> = {
  "lean-ask": LEAN_ASK_CRITERIA,
  "soft-details": SOFT_DETAILS_CRITERIA,
};

export function parseApprovalVariant(value = "current"): ApprovalVariant {
  const raw = value.trim() || "current";
  if (raw === "current") return { id: "current", parts: new Set() };
  const parts = raw.split("+").map((p) => p.trim());
  for (const part of parts)
    if (!(APPROVAL_VARIANT_PARTS as readonly string[]).includes(part))
      throw new Error(
        `Unknown approval variant part "${part}"; use current or ${APPROVAL_VARIANT_PARTS.join("+")}`,
      );
  if (parts.filter((p) => Object.hasOwn(RUBRICS, p)).length > 1)
    throw new Error(`Choose one rubric: ${Object.keys(RUBRICS).join(", ")}`);
  const ordered = APPROVAL_VARIANT_PARTS.filter((p) => parts.includes(p));
  return { id: ordered.join("+"), parts: new Set(ordered) };
}

/** The one rubric a variant names, used by both reviewer paths. */
export function variantRubric(variant: ApprovalVariant) {
  const part = [...variant.parts].find((p) => Object.hasOwn(RUBRICS, p));
  return part ? RUBRICS[part] : undefined;
}

const MAX_STEP_CHARS = 300;
const EARLIER_STEPS = 6;
const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** The extra situation a variant shows the reviewer. */
export function variantContext(c: ApprovalCase, variant: ApprovalVariant): Record<string, unknown> {
  if (!variant.parts.has("steps") || !c.runSteps?.length) return {};
  return {
    earlierSteps: c.runSteps.slice(-EARLIER_STEPS).map((step) => ({
      tool: step.tool,
      summary: clip((step.output ?? step.summary).trim(), MAX_STEP_CHARS),
      ...(step.outside ? { fromOutsideText: true } : {}),
    })),
  };
}

const notesFor = (extra: Record<string, unknown>) => (extra.earlierSteps ? EARLIER_STEPS_NOTE : "");

/**
 * Wraps the product's decision provider: adds the variant's situation to the state the product
 * built and swaps its general rubric, so the product's own verdict logic still decides.
 */
export class VariantDecisionProvider implements DecisionProvider {
  constructor(
    private readonly inner: DecisionProvider,
    private readonly variant: ApprovalVariant,
    private readonly caseForRun: (runId: string) => ApprovalCase | undefined,
  ) {}

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResult> {
    const c = this.caseForRun(context.runId ?? "");
    if (!c) throw new Error("Approval variant has no case for this run");
    const base = request.questions.decision;
    if (!base) throw new Error("Approval variant expected the product's decision question");
    const extra = variantContext(c, this.variant);
    const notes = notesFor(extra);
    // The product's new-site, lasting-write and own-computer rubrics are specific; only the general one changes.
    const general = isGeneralReview(request.state as ReviewedCall);
    const criteria = (general && variantRubric(this.variant)) || base.criteria;
    const instructions = [base.instructions, notes ? `${STATE_IS_DATA} ${notes}` : ""]
      .filter(Boolean)
      .join(" ");
    return this.inner.decide(
      {
        ...request,
        state: { ...request.state, ...extra },
        questions: { decision: { ...base, instructions, criteria } },
      },
      context,
    );
  }
}

type ReviewedCall = Parameters<typeof lastingWriteKind>[0];
/** Whether the product judges this call by its general rubric, the one a variant swaps. */
function isGeneralReview(call: ReviewedCall): boolean {
  return (
    !call.newSite && !call.savedContextWrite && !call.ownComputerAction && !lastingWriteKind(call)
  );
}

/** The same variant for a plain model that writes JSON, applied to the product's own prompt. */
export function variantPromptFor(
  basePrompt: string,
  c: ApprovalCase,
  variant: ApprovalVariant,
  escapeData: (value: string) => string,
): string {
  const extra = variantContext(c, variant);
  return variantPrompt(
    basePrompt,
    {
      rubric: variantRubric(variant),
      general: isGeneralReview(c),
      extra,
      notes: notesFor(extra),
    },
    escapeData,
  );
}
