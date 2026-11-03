import { createHash } from "node:crypto";
import type { CloudAgentProvider } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

/** Settings label for the live cursor provider. Vendor copy stays in this adapter. */
export const CURSOR_CLOUD_AGENT_NAME = "Cursor";

/** Opaque binding stored on each agent. A different hash fails closed. */
export function cloudAgentProviderKey(apiKey: string): string {
  return `cursor:${createHash("sha256").update(apiKey).digest("hex")}`;
}

/**
 * A deployment's cloud agents. The deploy provider exists only when both a key and a
 * Space are set. `userCredentialProviderId` means each user may save their own key.
 */
export interface CloudAgentConnection {
  /** Deploy or emulator provider. Absent when cursor is on without a deployment key. */
  provider?: CloudAgentProvider;
  /** Deploy binding. Empty when there is no deployment key. */
  key: string;
  /** Only the offline emulator may be available in every Space without a user key. */
  spaceId?: string;
  /** Adapter id of keys users save. Absent for the emulator. */
  userCredentialProviderId?: string;
  /** Shown in Settings. Present only for the live cursor provider. */
  displayName?: string;
}

export function cloudAgentsEnabled(
  connection: CloudAgentConnection | null | undefined,
  spaceId: string,
) {
  const provider = connection?.provider;
  return Boolean(
    provider &&
      (connection.spaceId === spaceId ||
        (!connection.spaceId && provider.describe().capabilities.offline)),
  );
}

/** A provider bound to one user key. The deployment provider is not reused. */
export function cloudAgentProviderForKey(apiKey: string): CloudAgentProvider {
  return new CursorCloudAgentProvider({ apiKey });
}

export function createCloudAgentConnection(
  source: NodeJS.ProcessEnv = process.env,
): CloudAgentConnection | null {
  const kind = resolveCloudAgentProvider(source);
  if (kind === "emulator") {
    return { provider: new EmulatorCloudAgentProvider(), key: "emulator" };
  }
  if (kind !== "cursor") return null;
  const apiKey = optional(source.CURSOR_API_KEY);
  const spaceId = optional(source.CLOUD_AGENT_SPACE_ID);
  const deploy =
    apiKey && spaceId
      ? {
          provider: new CursorCloudAgentProvider({ apiKey }),
          key: cloudAgentProviderKey(apiKey),
          spaceId,
        }
      : { key: "" };
  return {
    ...deploy,
    userCredentialProviderId: "cursor",
    displayName: CURSOR_CLOUD_AGENT_NAME,
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
