import type {
  AdapterContext,
  BrowserActStep,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { MAX_BROWSER_UPLOAD_FILES } from "@rakazo/adapter-kit";
import type { PurchaseCardField } from "@rakazo/contracts";
import { PURCHASE_CARD_FIELDS } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "./connector-safety.js";

const MAX_BROWSER_ACTIONS = 24;
/** The action kinds `browser_act` takes, as its tool schema lists them. */
export const BROWSER_ACT_KINDS = [
  "click",
  "fill",
  "type",
  "upload",
  "fill_secret",
  "fill_card",
  "fill_pay_token",
] as const;
const NAVIGATE_URL_REQUIRED = "An HTTP(S) URL without embedded credentials is required";

/** Fills a saved website login's field by its label; the model never supplies or sees the value. */
export type SecretFillStep = {
  kind: "fill_secret";
  ref: string;
  secret: string;
  field: string;
};
/** The model never supplies or sees the value. */
export type CardFillStep = {
  kind: "fill_card";
  ref?: string;
  purchase: string;
  field: PurchaseCardField;
};
/** The model never supplies or sees the token. */
export type PayTokenFillStep = { kind: "fill_pay_token"; purchase: string };
export type BrowserActInput = BrowserActStep | SecretFillStep | CardFillStep | PayTokenFillStep;
/** desktopTools: the run also has computer_act, so a page-tool failure can fall back to it. */
export type PageToolOptions = { desktopTools?: boolean };
export type ResolveSecretFill = (
  step: SecretFillStep,
) => Promise<{ text: string; origin: string; hidden: boolean } | { error: string }>;

export type ResolveCardFill = (
  step: CardFillStep,
) => Promise<{ text: string; origin: string } | { error: string }>;

export type ResolvePayTokenFill = (
  step: PayTokenFillStep,
) => Promise<{ text: string; origin: string; merchantAccountId: string } | { error: string }>;

/**
 * A browser tool call turned down before anything ran, such as a missing argument. It is settled:
 * nothing on the page changed, so the bot fixes the call instead of turning to desktop tools.
 */
class BrowserToolInputError extends Error {}

function refusedInput(message: string) {
  return { ok: false, uncertain: false, error: message };
}

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions = {},
) {
  const url = String(args.url ?? "").trim();
  if (!URL.canParse(url)) return refusedInput(NAVIGATE_URL_REQUIRED);
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    return refusedInput(NAVIGATE_URL_REQUIRED);
  }
  try {
    const result = await browser.navigate(computer, { url, signal: context.signal }, context);
    return formatBrowserResult(result, options);
  } catch (error) {
    context.signal.throwIfAborted();
    return formatBrowserResult(
      { error: error instanceof Error ? error.message : String(error), fallback: "computer_act" },
      options,
    );
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions = {},
) {
  void args;
  try {
    const result = await browser.snapshot(computer, { signal: context.signal }, context);
    return formatBrowserResult(result, options);
  } catch (error) {
    context.signal.throwIfAborted();
    return formatBrowserResult(
      { error: error instanceof Error ? error.message : String(error), fallback: "computer_act" },
      options,
    );
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: PageToolOptions & {
    resolveSecretFill?: ResolveSecretFill;
    resolveCardFill?: ResolveCardFill;
    resolvePayTokenFill?: ResolvePayTokenFill;
    redactions?: () => string[];
    /** Maps a bot-facing workspace path to its path in the computer's home. */
    resolveUploadPath?: (path: string) => string;
    /** Trusted upload roots relative to the computer home, set by the executor. */
    uploadRoots?: string[];
  } = {},
) {
  try {
    const actions: BrowserActStep[] = [];
    // Resolve every saved login and card before acting, so a missing one cannot leave a
    // half-filled form.
    for (const step of parseBrowserActions(args.actions)) {
      if (step.kind === "upload") {
        const resolve = options.resolveUploadPath ?? ((path: string) => path);
        let paths: string[];
        try {
          paths = step.paths.map(resolve);
        } catch (error) {
          // A path outside the bot's folder is the call's mistake, settled before anything runs.
          throw new BrowserToolInputError(error instanceof Error ? error.message : String(error));
        }
        actions.push({
          ...step,
          paths,
          ...(options.uploadRoots ? { roots: options.uploadRoots } : {}),
        });
        continue;
      }
      if (step.kind === "fill_pay_token") {
        let resolved: Awaited<ReturnType<ResolvePayTokenFill>>;
        try {
          resolved = options.resolvePayTokenFill
            ? await options.resolvePayTokenFill(step)
            : { error: "Pay tokens are unavailable here." };
        } catch (error) {
          context.signal.throwIfAborted();
          getLogger().warn("purchase pay token could not be loaded for a fill", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          return { ...refusedInput("This pay token could not be loaded."), completed: 0 };
        }
        if ("error" in resolved) return { ...refusedInput(resolved.error), completed: 0 };
        const { text, origin, merchantAccountId } = resolved;
        actions.push({ kind: "pay_token", text, origin, merchantAccountId });
        continue;
      }
      if (step.kind !== "fill_secret" && step.kind !== "fill_card") {
        actions.push(step);
        continue;
      }
      const card = step.kind === "fill_card";
      let resolved: { text: string; origin: string; hidden?: boolean } | { error: string };
      try {
        resolved = card
          ? options.resolveCardFill
            ? await options.resolveCardFill(step)
            : { error: "Card fills are unavailable here." }
          : options.resolveSecretFill
            ? await options.resolveSecretFill(step)
            : { error: "Saved logins are unavailable here." };
      } catch (error) {
        context.signal.throwIfAborted();
        // A stored login or card that can't be read may quote its own text in the error, so
        // neither the bot nor the log gets the message: only that it failed, and how.
        getLogger().warn(
          card
            ? "purchase card could not be loaded for a fill"
            : "saved login could not be loaded for a fill",
          { errorName: error instanceof Error ? error.name : typeof error },
        );
        return {
          ...refusedInput(
            card ? "This card could not be loaded." : "This saved login could not be loaded.",
          ),
          completed: 0,
        };
      }
      if ("error" in resolved) return { ...refusedInput(resolved.error), completed: 0 };
      const { text, origin } = resolved;
      if (step.ref === undefined) {
        actions.push({ kind: "fill", text, origin, field: "card", cardField: step.field });
      } else {
        actions.push({
          kind: "fill",
          ref: step.ref,
          text,
          origin,
          // Every page browser, older computer images included, types "password" only into a
          // password field and "username" into a text, email or telephone field.
          field: card ? "card" : resolved.hidden === false ? "username" : "password",
        });
      }
    }
    const result = await browser.act(computer, { actions, signal: context.signal }, context);
    return redactConnectorPayload(
      formatBrowserResult(result, options),
      options.redactions?.() ?? [],
    );
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof BrowserToolInputError)
      return { ...refusedInput(error.message), completed: 0 };
    return formatBrowserResult(
      {
        ok: false,
        uncertain: true,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      },
      options,
    );
  }
}

export function parseBrowserActions(value: unknown): BrowserActInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrowserToolInputError("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new BrowserToolInputError(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new BrowserToolInputError(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as (typeof BROWSER_ACT_KINDS)[number];
    if (!(BROWSER_ACT_KINDS as readonly string[]).includes(kind)) {
      throw new BrowserToolInputError(
        `browser_act action ${index} needs kind: ${BROWSER_ACT_KINDS.join(", ")}`,
      );
    }
    const ref = String(action.ref ?? "").trim();
    if (kind === "fill_pay_token") {
      const purchase = String(action.purchase ?? "").trim();
      if (!purchase)
        throw new BrowserToolInputError(
          "browser_act fill_pay_token needs purchase: the id of an approved purchase",
        );
      return { kind, purchase };
    }
    if (kind === "fill_card") {
      const purchase = String(action.purchase ?? "").trim();
      const field = action.field;
      if (!purchase)
        throw new BrowserToolInputError(
          "browser_act fill_card needs purchase: the id of an approved purchase",
        );
      if (!(PURCHASE_CARD_FIELDS as readonly unknown[]).includes(field)) {
        throw new BrowserToolInputError(
          `browser_act fill_card needs field: ${PURCHASE_CARD_FIELDS.map((name) => `"${name}"`).join(", ")}`,
        );
      }
      return { kind, ...(ref ? { ref } : {}), purchase, field: field as PurchaseCardField };
    }
    if (!ref) throw new BrowserToolInputError(`browser_act action ${index} requires ref`);
    if (kind === "upload") {
      const paths = Array.isArray(action.paths)
        ? action.paths.map((path) => (typeof path === "string" ? path.trim() : ""))
        : [];
      if (paths.length === 0 || paths.some((path) => !path)) {
        throw new BrowserToolInputError(
          "browser_act upload requires paths: one or more file paths",
        );
      }
      if (paths.length > MAX_BROWSER_UPLOAD_FILES) {
        throw new BrowserToolInputError(
          `browser_act upload accepts at most ${MAX_BROWSER_UPLOAD_FILES} files`,
        );
      }
      return { kind, ref, paths };
    }
    if (kind === "fill_secret") {
      const secret = String(action.secret ?? "").trim();
      const field = typeof action.field === "string" ? action.field.trim() : "";
      if (!secret)
        throw new BrowserToolInputError(
          "browser_act fill_secret needs secret: the name of a login saved with request_secret",
        );
      if (!field) {
        throw new BrowserToolInputError(
          "browser_act fill_secret needs field: the label of one of the login's fields",
        );
      }
      return { kind, ref, secret, field };
    }
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new BrowserToolInputError(
          action.secret === undefined && action.field === undefined
            ? `browser_act ${kind} requires text`
            : `browser_act ${kind} requires text; for a saved login use kind "fill_secret"`,
        );
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

function formatBrowserResult<T extends { fallback?: "computer_act"; error?: string }>(
  result: T,
  { desktopTools = true }: PageToolOptions,
) {
  if (result.fallback !== "computer_act") return result;
  if (desktopTools) {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  // Without desktop tools, pointing at computer_act leaves only request_takeover. A browser
  // that is still starting after the computer woke up usually answers a moment later.
  const { fallback: _fallback, ...rest } = result;
  return {
    ...rest,
    note: "Page browser could not complete this step. The computer or its browser may still be starting, so call browser_snapshot again to check the page. Use request_takeover only if it keeps failing. Do not replay completed or uncertain actions.",
  };
}
