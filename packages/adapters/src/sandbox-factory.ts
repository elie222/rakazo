import type { SandboxProvider } from "@rakazo/adapter-kit";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";

export interface SandboxProviderOptions {
  hostComputerUrl?: string;
  hostComputerToken?: string;
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  createosApiKey?: string;
  createosBaseUrl?: string;
  createosShape?: string;
  createosRootfs?: string;
  railwayApiToken?: string;
  railwayEnvironmentId?: string;
  railwayMaxWorkspaceFileBytes?: string;
  railwaySandboxRegion?: string;
  boatApiKey?: string;
  boatApiUrl?: string;
  dataDir?: string;
}

function missingRemoteKey(
  provider: "e2b" | "daytona" | "createos" | "boat" | "railway",
  envName: string,
): SandboxProvider {
  return new NoneSandboxProvider(
    `Computers unavailable: ${envName} is required for SANDBOX_PROVIDER=${provider}.`,
  );
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "none":
    case "":
      return new NoneSandboxProvider();
    case "e2b":
      if (!opts.e2bApiKey?.trim()) return missingRemoteKey("e2b", "E2B_API_KEY");
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "daytona":
      if (!opts.daytonaApiKey?.trim()) return missingRemoteKey("daytona", "DAYTONA_API_KEY");
      return new DaytonaSandboxProvider({
        apiKey: opts.daytonaApiKey,
        apiUrl: opts.daytonaApiUrl,
        target: opts.daytonaTarget,
      });
    case "createos":
      if (!opts.createosApiKey?.trim())
        return missingRemoteKey("createos", "CREATEOS_SANDBOX_API_KEY");
      return new CreateOSSandboxProvider({
        apiKey: opts.createosApiKey,
        baseUrl: opts.createosBaseUrl,
        shape: opts.createosShape,
        rootfs: opts.createosRootfs,
      });
    case "boat":
      if (!opts.boatApiKey?.trim()) return missingRemoteKey("boat", "BOAT_API_KEY");
      return new BoatSandboxProvider({ apiKey: opts.boatApiKey, apiUrl: opts.boatApiUrl });
    case "railway":
      if (!opts.railwayApiToken?.trim()) return missingRemoteKey("railway", "RAILWAY_API_TOKEN");
      if (!opts.railwayEnvironmentId?.trim())
        return missingRemoteKey("railway", "RAILWAY_ENVIRONMENT_ID");
      return new RailwaySandboxProvider({
        token: opts.railwayApiToken,
        environmentId: opts.railwayEnvironmentId,
        maxWorkspaceFileBytes: opts.railwayMaxWorkspaceFileBytes,
        region: opts.railwaySandboxRegion,
      });
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "desktop":
      assertHostCommandsAllowed();
      return new DesktopSandboxProvider({
        root: opts.dataDir,
      });
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | e2b | daytona | createos | boat | railway | desktop | fake.`,
      );
  }
}
