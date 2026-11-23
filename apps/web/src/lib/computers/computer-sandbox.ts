import { t } from "@lingui/core/macro";
import type { ComputerStatus, Me } from "@rakazo/contracts";
import { rpc } from "../query/rpc";
import { errorText } from "../query/user-error";

/**
 * Whether the computer is the user's own machine. A server from before `runsOnUserMachine` says
 * so only by its kind; drop that reading once such servers are no longer supported.
 */
export function runsOnUserMachine(
  computer: Pick<ComputerStatus, "kind" | "runsOnUserMachine"> | null | undefined,
): boolean {
  return computer?.runsOnUserMachine ?? computer?.kind === "desktop";
}

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

/** Whether an account may run its computers on its own provider on this deployment. */
export function canChooseOwnComputer(sandboxProvider: string | null | undefined): boolean {
  // Those deployments run every computer on the server's own provider.
  return (
    !!sandboxProvider &&
    !computersAreUnavailable(sandboxProvider) &&
    sandboxProvider !== "desktop" &&
    sandboxProvider !== "fake"
  );
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
