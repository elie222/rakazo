import { canonicalPiProviderId } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";

/**
 * Catalog provider ids a deployment lets its users connect, read from the environment the
 * API and worker share. Entries are folded and canonicalized like stored provider ids, so
 * a name the registry renamed still matches. Unset or blank means every provider, exactly
 * the behavior without it.
 */
export function modelProviderAllowlist(): ReadonlySet<string> | null {
  const raw = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST?.trim();
  if (!raw) return null;
  const ids = new Set(
    raw
      .split(",")
      .map((id) => canonicalPiProviderId(id.trim().toLowerCase()))
      .filter((id) => id !== ""),
  );
  return ids.size > 0 ? ids : null;
}

/** Whether users may connect, run, or import this catalog provider on this deployment. */
export function modelProviderAllowed(
  allowlist: ReadonlySet<string> | null,
  provider: string,
): boolean {
  return allowlist === null || allowlist.has(canonicalPiProviderId(provider));
}

/** Refuses a provider this deployment's allowlist leaves out. */
export function assertModelProviderAllowed(provider: string) {
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) {
    throw new ModelProviderNotAllowedError();
  }
}

/**
 * The model pin a copy or a restored bot may be born with. The provider and model stay only
 * while the deployment allowlist offers that provider, so the copy follows the account's main
 * model instead of a pin its runs would refuse. The thinking level is its own setting and
 * travels either way.
 */
export function carriedBotModelPin(source: {
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
}) {
  const pin =
    source.modelProvider && modelProviderAllowed(modelProviderAllowlist(), source.modelProvider)
      ? { modelProvider: source.modelProvider, modelId: source.modelId }
      : {};
  return { ...pin, thinkingLevel: source.thinkingLevel };
}

/**
 * The model pin a restored routine carries. A routine's thinking level belongs to its pinned
 * model, so it goes when the pin does: the routine routes refuse a level with no model.
 */
export function carriedRoutineModelPin(source: {
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
}) {
  if (!source.modelProvider) return {};
  if (!modelProviderAllowed(modelProviderAllowlist(), source.modelProvider)) return {};
  return {
    modelProvider: source.modelProvider,
    modelId: source.modelId,
    thinkingLevel: source.thinkingLevel,
  };
}

/** One refusal shared by every allowlist gate, so one setting reads as one rule. */
export const MODEL_PROVIDER_NOT_ALLOWED_ERROR =
  "This model provider is not allowed on this server.";

/** A provider this deployment does not offer, which the caller can pick another of. */
export class ModelProviderNotAllowedError extends ClientError {
  constructor() {
    super("BAD_REQUEST", MODEL_PROVIDER_NOT_ALLOWED_ERROR, "model_provider_not_allowed");
    this.name = "ModelProviderNotAllowedError";
  }
}
