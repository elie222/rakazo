import type { Me } from "@rakazo/contracts";
import { rpc } from "./rpc";

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

/** Lines to paste into `.env` — placeholders only, never real secrets. */
export function sandboxEnvGuidanceLines(): string[] {
  return [
    "# Docker on your server or Compose stack",
    "SANDBOX_PROVIDER=docker",
    "SANDBOX_SUPERVISOR_TOKEN=<generate-a-secret>",
    "",
    "# Or a hosted sandbox (pick one provider and its key)",
    "SANDBOX_PROVIDER=e2b",
    "E2B_API_KEY=<your-key>",
    "",
    "SANDBOX_PROVIDER=daytona",
    "DAYTONA_API_KEY=<your-key>",
    "",
    "SANDBOX_PROVIDER=box",
    "BOX_API_KEY=<your-key>",
    "",
    "# Recreate the stack after changing .env",
  ];
}

export function sandboxEnvGuidanceText(): string {
  return sandboxEnvGuidanceLines().join("\n");
}

export type SandboxProviderKind = "none" | "docker" | "hosted" | "other";

export function classifySandboxProvider(provider: string | null | undefined): SandboxProviderKind {
  if (provider == null || provider === "" || computersAreUnavailable(provider)) return "none";
  if (provider === "docker" || provider === "desktop") return "docker";
  if (provider === "e2b" || provider === "daytona" || provider === "box") return "hosted";
  return "other";
}

export function sandboxProviderLabel(provider: string): string {
  if (provider === "docker") return "Docker";
  if (provider === "desktop") return "Desktop";
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  if (provider === "box") return "Box";
  if (provider === "fake") return "Fake";
  return provider;
}

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not reach the server";
}
