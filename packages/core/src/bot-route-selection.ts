export type BotRoute = {
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  execution: "inline" | "background" | "specialist";
};

export type BotRouteSelection = {
  route: BotRoute;
  source: "persisted" | "explicit" | "classifier" | "default";
  fallbackReason?: "disabled" | "missing-label" | "unknown-label" | "invalid-route";
};

/** Routes come from validated product configuration, never a classifier-supplied tuple. */
export function selectBotRoute(input: {
  persisted?: BotRoute;
  explicit?: BotRoute;
  enabled: boolean;
  routes: readonly BotRoute[];
  classifierLabel?: string;
  defaultRoute: BotRoute;
  isValid: (route: BotRoute) => boolean;
}): BotRouteSelection {
  if (input.persisted || input.explicit) {
    const route = input.persisted ?? input.explicit;
    if (!route || !input.isValid(route)) {
      throw new Error("The pinned or explicit model route is no longer available.");
    }
    return { route, source: input.persisted ? "persisted" : "explicit" };
  }
  let fallbackReason: BotRouteSelection["fallbackReason"] = "disabled";
  if (input.enabled) {
    const matches = input.routes.filter((route) => route.label === input.classifierLabel);
    const route = matches.length === 1 ? matches[0] : undefined;
    if (route && input.isValid(route)) return { route, source: "classifier" };
    fallbackReason = !input.classifierLabel
      ? "missing-label"
      : route
        ? "invalid-route"
        : "unknown-label";
  }
  if (!input.isValid(input.defaultRoute)) {
    throw new Error("No valid configured default model route is available.");
  }
  return { route: input.defaultRoute, source: "default", fallbackReason };
}
