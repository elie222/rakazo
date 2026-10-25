import type { SandboxProviderOptions } from "./sandbox-factory.js";

/** Empty or remote provider without a key becomes none so services can boot for signup. */
export function resolveSandboxProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.SANDBOX_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = configured?.trim() || "docker";
  if (requested === "none") return "none";
  if (requested === "e2b" && !optional(source.E2B_API_KEY)) return "none";
  if (requested === "daytona" && !optional(source.DAYTONA_API_KEY)) return "none";
  if (requested === "createos" && !optional(source.CREATEOS_SANDBOX_API_KEY)) return "none";
  if (requested === "boat" && !boatApiKeyFromEnv(source)) return "none";
  if (
    requested === "railway" &&
    (!optional(source.RAILWAY_API_TOKEN) || !optional(source.RAILWAY_ENVIRONMENT_ID))
  )
    return "none";
  // Production without a supervisor token cannot run Docker computers; boot as none instead of exiting.
  if (
    requested === "docker" &&
    source.NODE_ENV === "production" &&
    !optional(source.SANDBOX_SUPERVISOR_TOKEN)
  ) {
    return "none";
  }
  return requested;
}

/** Remote computer credentials for the adapter factory. */
export function sandboxProviderOptionsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): Pick<
  SandboxProviderOptions,
  | "hostComputerUrl"
  | "hostComputerToken"
  | "e2bApiKey"
  | "daytonaApiKey"
  | "daytonaApiUrl"
  | "daytonaTarget"
  | "createosApiKey"
  | "createosBaseUrl"
  | "createosShape"
  | "createosRootfs"
  | "railwayApiToken"
  | "railwayEnvironmentId"
  | "railwayMaxWorkspaceFileBytes"
  | "railwaySandboxRegion"
  | "boatApiKey"
  | "boatApiUrl"
> {
  return {
    hostComputerUrl: source.SANDBOX_HOST_URL,
    hostComputerToken: source.SANDBOX_HOST_TOKEN,
    e2bApiKey: source.E2B_API_KEY,
    daytonaApiKey: source.DAYTONA_API_KEY,
    daytonaApiUrl: source.DAYTONA_API_URL,
    daytonaTarget: source.DAYTONA_TARGET,
    createosApiKey: source.CREATEOS_SANDBOX_API_KEY,
    createosBaseUrl: source.CREATEOS_SANDBOX_BASE_URL,
    createosShape: source.CREATEOS_SANDBOX_SHAPE,
    createosRootfs: source.CREATEOS_SANDBOX_ROOTFS,
    railwayApiToken: source.RAILWAY_API_TOKEN,
    railwayEnvironmentId: source.RAILWAY_ENVIRONMENT_ID,
    railwayMaxWorkspaceFileBytes: source.RAILWAY_MAX_WORKSPACE_FILE_BYTES,
    railwaySandboxRegion: optional(source.RAILWAY_SANDBOX_REGION),
    boatApiKey: boatApiKeyFromEnv(source),
    boatApiUrl: boatApiUrlFromEnv(source),
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function boatApiKeyFromEnv(source: NodeJS.ProcessEnv): string | undefined {
  return optional(source.BOAT_API_KEY);
}

export function boatApiUrlFromEnv(source: NodeJS.ProcessEnv): string | undefined {
  return optional(source.BOAT_API_URL);
}
