import type {
  ComputerRef,
  SandboxKindCapabilities,
  SandboxProvider,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import type { ComputerProviderDescriptor, ComputerProviderField } from "@rakazo/contracts";
import type { KubernetesSandboxOptions } from "../providers/computer/kubernetes/kubernetes-sandbox.js";

export interface SandboxProviderOptions {
  hostComputerUrl?: string;
  hostComputerToken?: string;
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  novitaApiKey?: string;
  sandboxTemplate?: string;
  onUnsafeStop?: (providerRef: string) => Promise<void>;
  /** Whether another running computer still uses the same provider resource. */
  referenceInUse?: (computer: ComputerRef) => Promise<boolean>;
  /** Keeps a durable record of machines a provider created that no computer stores yet. */
  unreferencedMachines?: UnreferencedMachineRecords;
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
  boxdApiKey?: string;
  boxdOrg?: string;
  instaboxApiKey?: string;
  kubernetesNamespace?: string;
  kubernetesRuntimeClassName?: string;
  kubernetesComputerImage?: string;
  kubernetesCpuLimit?: string;
  kubernetesMemoryLimit?: string;
  kubernetesPodAnnotations?: KubernetesSandboxOptions["podAnnotations"];
  kubernetesPodLabels?: KubernetesSandboxOptions["podLabels"];
  kubernetesReadyTimeoutMs?: number;
  kubernetesHomeClaim?: string;
  kubernetesHomeColocateNamespace?: string;
  kubernetesHomeColocateLabels?: KubernetesSandboxOptions["homeColocateLabels"];
  incusUrl?: string;
  incusClientCert?: string;
  incusClientKey?: string;
  incusServerCert?: string;
  incusProject?: string;
  incusComputerImage?: string;
  incusCpuLimit?: string;
  incusMemoryLimit?: string;
  incusProcessLimit?: string;
  localVmCli?: string;
  localVmComputerImage?: string;
  localVmCpus?: string;
  localVmMemory?: string;
  wuyingAccessKeyId?: string;
  wuyingAccessKeySecret?: string;
  wuyingRegionId?: string;
  wuyingDesktopId?: string;
  wuyingEndUserId?: string;
  wuyingMcpUrl?: string;
  wuyingMcpToken?: string;
  dataDir?: string;
}

/** Options the process wires up itself rather than reading from a provider's settings. */
type WiredOption =
  | "hostComputerUrl"
  | "hostComputerToken"
  | "supervisorUrl"
  | "supervisorToken"
  | "onUnsafeStop"
  | "referenceInUse"
  | "unreferencedMachines"
  | "dataDir";

export type SandboxSettingOption = Exclude<keyof SandboxProviderOptions, WiredOption>;

export interface EnvBinding<T> {
  name: string;
  /** Defaults to the trimmed value, with a blank one unset. */
  read?: (value: string | undefined, source: NodeJS.ProcessEnv) => T;
  /** Without it the provider cannot run, so the deployment boots without computers. */
  required?: boolean;
}

export type EnvBindings = {
  [K in SandboxSettingOption]?: EnvBinding<SandboxProviderOptions[K]>;
};

export interface ComputerSettingsField extends Omit<ComputerProviderField, "required"> {
  /** The option this field sets; it is required exactly when that option's binding is. */
  option: SandboxSettingOption;
}

/** One computer provider: everything the factory, environment, Settings and tests read about it. */
export interface ComputerProviderDefinition {
  capabilities: SandboxKindCapabilities;
  env?: EnvBindings;
  /** Present when a Space or account can connect this provider from Settings. */
  settings?: {
    displayName: string;
    perAccount?: boolean;
    fields: readonly ComputerSettingsField[];
    /** Checks beyond each field's own. */
    validate?(values: Record<string, string>): void;
    verifyConnection?(values: Record<string, string>, signal: AbortSignal): Promise<void>;
  };
  /** Whether the environment leaves the provider unable to run beyond a missing required option. */
  unavailable?(source: NodeJS.ProcessEnv): boolean;
  /** Loads the provider's module only when it is used. */
  create(options: SandboxProviderOptions): Promise<SandboxProvider>;
}

export interface SettingsComputerProvider extends ComputerProviderDescriptor {
  verify(values: Record<string, string>): SandboxProviderOptions;
  verifyConnection?(values: Record<string, string>, signal: AbortSignal): Promise<void>;
}

export function envBindings({ env = {} }: ComputerProviderDefinition) {
  return Object.entries(env) as [SandboxSettingOption, EnvBinding<unknown>][];
}

export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** The value exactly as set, untrimmed. */
export function raw(value: string | undefined): string | undefined {
  return value;
}

/** PEM text, with `\n` escapes allowed so it fits on one line of an env file. */
export function pem(value: string | undefined): string | undefined {
  return optional(value)?.replace(/\\n/g, "\n");
}

export function stringMap(name: string): EnvBinding<Record<string, string> | undefined> {
  return {
    name,
    read(value) {
      const configured = optional(value);
      if (!configured) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(configured);
      } catch (error) {
        throw new Error(`${name} must be a JSON object of string values`, { cause: error });
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((entry) => typeof entry !== "string")
      ) {
        throw new Error(`${name} must be a JSON object of string values`);
      }
      return parsed as Record<string, string>;
    },
  };
}

export function positiveInteger(name: string): EnvBinding<number | undefined> {
  return {
    name,
    read(value) {
      const configured = optional(value);
      if (!configured) return undefined;
      const parsed = Number(configured);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
      return parsed;
    },
  };
}
