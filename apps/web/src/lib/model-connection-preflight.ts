import { plural, t } from "@lingui/core/macro";
import { sanitizeModelConnectionError } from "@rakazo/core";

type ModelPreflightOutcome =
  | "timeout"
  | "rate_limit"
  | "unauthorized"
  | "unavailable_model"
  | "unreachable"
  | "missing_fields"
  | "unknown";

export type ModelPreflightFailure = {
  outcome: ModelPreflightOutcome;
  message: string;
  nextAction: string;
};

type KnownSecrets = ReadonlyArray<string | null | undefined>;

function messageFromError(error: unknown, secrets?: KnownSecrets): string {
  return sanitizeModelConnectionError(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
}

/** `secrets` are the credentials the connection was tested with; the message never shows them. */
export function classifyModelConnectionFailure(
  error: unknown,
  context: {
    modelId?: string;
    discoveredModels?: string[];
    manualEntry?: boolean;
    secrets?: KnownSecrets;
  } = {},
): ModelPreflightFailure {
  const message = messageFromError(error, context.secrets);
  // Read from what the provider said: hiding a credential can take the word that names the failure.
  const lower = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (context.modelId && context.discoveredModels && context.discoveredModels.length > 0) {
    const modelId = sanitizeModelConnectionError(context.modelId.trim(), context.secrets);
    if (modelId && !context.discoveredModels.includes(context.modelId.trim())) {
      return {
        outcome: "unavailable_model",
        message: t`Model "${modelId}" was not listed.`,
        nextAction:
          context.manualEntry === false
            ? t`Pick a model from the catalog.`
            : t`Pick a model from the list or enter a model id served by this endpoint.`,
      };
    }
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      outcome: "timeout",
      message: message || t`The connection timed out.`,
      nextAction: t`Check the server URL and network, then test again.`,
    };
  }

  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("rate-limit")) {
    return {
      outcome: "rate_limit",
      message: message || t`The provider is rate-limiting requests.`,
      nextAction: t`Wait a moment and test again.`,
    };
  }

  if (
    /\b(401|403)\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return {
      outcome: "unauthorized",
      message: message || t`Authentication failed.`,
      nextAction: t`Check the API key or sign-in, then test again.`,
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("could not reach")
  ) {
    return {
      outcome: "unreachable",
      message: message || t`Could not reach the model server.`,
      nextAction: t`Confirm the URL is reachable from this browser session, then test again.`,
    };
  }

  return {
    outcome: "unknown",
    message: message || t`Connection test failed.`,
    nextAction: t`Review provider settings and test again.`,
  };
}

/** Failure when a non-empty model list omits the selected id. Empty lists stay reachable. */
export function unavailableSelectedModel(
  modelId: string | undefined,
  discoveredModels: string[],
  options?: { manualEntry?: boolean },
): ModelPreflightFailure | null {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed || discoveredModels.length === 0 || discoveredModels.includes(trimmed)) return null;
  return classifyModelConnectionFailure(new Error("model not listed"), {
    modelId: trimmed,
    discoveredModels,
    manualEntry: options?.manualEntry,
  });
}

type ModelConnectionPreflightInput = {
  provider: string;
  apiKey?: string;
  modelId?: string;
  /** Catalog entry says this provider has a pinned models-list URL. */
  catalogProbe?: boolean;
  probeCatalog?: (input: { provider: string; apiKey: string }) => Promise<{ models: string[] }>;
};

export async function runModelConnectionPreflight(
  input: ModelConnectionPreflightInput,
): Promise<
  { ok: true; discoveredModels: string[] } | { ok: false; failure: ModelPreflightFailure }
> {
  const trimmedKey = input.apiKey?.trim() ?? "";
  const trimmedModel = input.modelId?.trim() ?? "";

  if (trimmedKey.length < 8) {
    return {
      ok: false,
      failure: {
        outcome: "missing_fields",
        message: t`Enter an API key before testing.`,
        nextAction: t`Paste your API key, then test again.`,
      },
    };
  }
  if (!input.catalogProbe || !input.probeCatalog) {
    return {
      ok: false,
      failure: {
        outcome: "unknown",
        message: t`This provider cannot be tested without saving.`,
        nextAction: t`Use Connect to verify the key.`,
      },
    };
  }
  try {
    const { models } = await input.probeCatalog({
      provider: input.provider,
      apiKey: trimmedKey,
    });
    const unavailable = unavailableSelectedModel(trimmedModel, models, { manualEntry: false });
    if (unavailable) return { ok: false, failure: unavailable };
    return { ok: true, discoveredModels: models };
  } catch (error) {
    return {
      ok: false,
      failure: classifyModelConnectionFailure(error, {
        modelId: trimmedModel,
        secrets: [trimmedKey],
      }),
    };
  }
}

/** Catalog models-list result. Custom servers use `openAiCompatibleProbeSuccessMessage`. */
export function modelPreflightSuccessMessage(modelCount: number): string {
  if (modelCount === 0) {
    return t`No models listed.`;
  }
  return t`Models list OK. ${plural(modelCount, {
    one: "# model",
    other: "# models",
  })} available. Chat was not tested.`;
}
