import { createHash } from "node:crypto";
import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { MemoryProviderDescriptor, ProviderSettingsField } from "@rakazo/contracts";

/** One memory provider: everything the factory, Settings and tests read about it. */
export interface MemoryProviderDefinition {
  /** The settings form the provider asks for, and how it names a saved connection. */
  settings: Omit<MemoryProviderDescriptor, "id"> & {
    /** One line naming a saved connection, shown beside its connected state. */
    connectionLabel(settings: Record<string, string>): string;
    /** Saved settings no field edits; an edit keeps their stored values. */
    keptSettings?: readonly string[];
  };
  requiresPrivateEndpoint(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
  /** Recheck persisted endpoint settings before their credentials are decrypted. */
  revalidate?(settings: Record<string, string>): Promise<void>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options?: { allowPrivateEndpoint?: boolean },
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    connectionVersion?: string,
  ): SemanticMemoryProvider;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
  /**
   * Everything the stored credentials can reach with these settings, normalized as prepare
   * saves it. When this changes, the stored credentials must not follow.
   */
  credentialTarget(settings: Record<string, string>): string;
}

/** Binds stored cleanup work to the saved connection and endpoint, never to credential plaintext. */
export function memoryConnectionIdentity(
  connectionVersion: string | undefined,
  baseUrl: string,
): string | undefined {
  return connectionVersion
    ? createHash("sha256")
        .update(JSON.stringify([connectionVersion, baseUrl]))
        .digest("hex")
    : undefined;
}

/** Every provider turns a key shorter than this down. */
export const MEMORY_SECRET_MIN_LENGTH = 8;

/** The hosted service, or a self-hosted server at a base URL. Both decide what a key reaches. */
export const connectionModeFields: readonly ProviderSettingsField[] = [
  {
    key: "mode",
    label: "Connection",
    kind: "select",
    required: true,
    default: "cloud",
    options: [
      { value: "cloud", label: "Cloud" },
      { value: "local", label: "Self-hosted" },
    ],
    advanced: true,
    scopesSecrets: true,
  },
  {
    key: "baseUrl",
    label: "Base URL",
    kind: "url",
    required: true,
    placeholder: "https://…",
    advanced: true,
    visibleWhen: { key: "mode", equals: "local" },
    scopesSecrets: true,
  },
];

/** "Self-hosted (https://memory.example.test)", for a connection to someone's own server. */
export function selfHostedLabel(settings: Record<string, string>): string {
  return `Self-hosted (${settings.baseUrl})`;
}

/** Cloud, or the self-hosted server's base URL. */
export function serviceTarget(settings: Record<string, string>, defaultMode?: "cloud"): string {
  const mode = settings.mode ?? defaultMode;
  if (mode === "cloud") return "cloud";
  // Clients drop trailing slashes, so they name the same server.
  return `${mode ?? ""} ${settings.baseUrl?.trim().replace(/\/+$/, "") ?? ""}`;
}
