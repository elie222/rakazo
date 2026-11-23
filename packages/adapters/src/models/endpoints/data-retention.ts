import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelConnectInput } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { modelProviderDefinition } from "../model-provider-registry.js";

/** A request for zero data retention that the chosen provider or checker cannot enforce. */
export class DataRetentionRefusedError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message, "DATA_RETENTION_UNSUPPORTED");
    this.name = "DataRetentionRefusedError";
  }
}

type RetentionRouting = Record<string, unknown> & { zdr?: boolean };

/** Whether the provider can restrict a request to endpoints that keep no prompts. */
export function providerHasDataRetentionControl(provider: string): boolean {
  return modelProviderDefinition(provider)?.dataRetentionControl === true;
}

/**
 * The flag a saved connection should carry. Omitted keeps the stored value; an explicit false
 * clears it. Turning it on for a provider without the control is refused, never ignored, so a
 * connection never looks protected when nothing enforces it.
 */
export function dataRetentionForConnect(
  input: Pick<ModelConnectInput, "provider" | "zeroDataRetention">,
  previous?: boolean,
): true | undefined {
  const requested = input.zeroDataRetention ?? previous;
  if (requested !== true) return undefined;
  if (!providerHasDataRetentionControl(input.provider)) {
    if (input.zeroDataRetention === true) {
      throw new DataRetentionRefusedError("This provider cannot restrict data retention.");
    }
    return undefined;
  }
  return true;
}

/**
 * The model with zero data retention routing set, merged into whatever routing it already
 * carries. Both wire shapes read it: chat completions send it as the request's `provider`
 * field directly, and the messages shape through `withDataRetentionPayload`.
 */
export function withDataRetention<T extends Model<Api>>(
  model: T,
  config: { zeroDataRetention?: boolean },
): T {
  if (config.zeroDataRetention !== true || !providerHasDataRetentionControl(model.provider)) {
    return model;
  }
  const compat = (model.compat ?? {}) as { openRouterRouting?: RetentionRouting };
  return {
    ...model,
    compat: { ...compat, openRouterRouting: { ...compat.openRouterRouting, zdr: true } },
  } as T;
}

/**
 * The messages API ignores the routing on the model, so its request body gets the same
 * `provider` field after every other payload hook. Other APIs are left as they are.
 */
export function withDataRetentionPayload<O extends SimpleStreamOptions>(
  model: Pick<Model<Api>, "api" | "compat">,
  options: O,
): O {
  if (model.api !== "anthropic-messages") return options;
  const routing = (model.compat as { openRouterRouting?: RetentionRouting } | undefined)
    ?.openRouterRouting;
  if (routing?.zdr !== true) return options;
  const previous = options.onPayload;
  return {
    ...options,
    async onPayload(payload, requestModel) {
      const replaced = await previous?.(payload, requestModel);
      const body = replaced ?? payload;
      if (typeof body !== "object" || body === null || Array.isArray(body)) return replaced;
      const existing = (body as { provider?: unknown }).provider;
      return {
        ...body,
        provider: {
          ...(typeof existing === "object" && existing !== null ? existing : {}),
          ...routing,
        },
      };
    },
  };
}
