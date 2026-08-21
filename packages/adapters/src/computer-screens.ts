import type { AdapterContext } from "@rakazo/adapter-kit";
import { canReleaseScreenLease, canTakeScreenLease } from "@rakazo/core";

export const MULTI_SCREEN_UNAVAILABLE =
  "This computer provider does not support multiple screens. Desktop tools are already in use on the shared display. File and shell tools still work.";

export class ComputerScreenUnavailableError extends Error {
  constructor(message = MULTI_SCREEN_UNAVAILABLE) {
    super(message);
    this.name = "ComputerScreenUnavailableError";
  }
}

export function screenSessionKey(context: AdapterContext): string {
  return context.botId ?? "default";
}

export class SingleScreenClaimTracker {
  private readonly owners = new Map<string, { screenKey: string; leaseId?: string }>();

  claim(computerId: string, context: AdapterContext): void {
    const key = screenSessionKey(context);
    const owner = this.owners.get(computerId);
    if (owner && owner.screenKey !== key) {
      throw new ComputerScreenUnavailableError();
    }
    if (owner && !canTakeScreenLease(owner.leaseId, context.screenLeaseId)) {
      if (context.screenLeaseId && owner.leaseId && context.screenLeaseId !== owner.leaseId) {
        throw new ComputerScreenUnavailableError();
      }
    }
    this.owners.set(computerId, {
      screenKey: key,
      leaseId: canTakeScreenLease(owner?.leaseId, context.screenLeaseId)
        ? context.screenLeaseId
        : (owner?.leaseId ?? context.screenLeaseId),
    });
  }

  release(computerId: string, context?: AdapterContext): void {
    if (!context) {
      this.owners.delete(computerId);
      return;
    }
    const owner = this.owners.get(computerId);
    if (
      owner?.screenKey === screenSessionKey(context) &&
      canReleaseScreenLease(owner.leaseId, context.screenLeaseId)
    ) {
      this.owners.delete(computerId);
    }
  }
}

export function isComputerScreenUnavailable(error: unknown): error is Error {
  return (
    error instanceof ComputerScreenUnavailableError ||
    (error instanceof Error && /cannot allocate another screen/i.test(error.message))
  );
}

export async function withComputerScreenAvailability<T>(
  work: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (isComputerScreenUnavailable(error)) return { error: error.message };
    throw error;
  }
}
