import { getLogger } from "@rakazo/logging";

/**
 * The memory provider refused the operator's account, so memory is off until someone fixes it.
 * One stable warning per refused call, whatever the provider, so a single monitor can alert on it.
 */
export function warnMemoryAccountRefused(operation: "recall" | "retain", error: string): void {
  getLogger().warn("memory.account_refused", { "memory.operation": operation, error });
}
