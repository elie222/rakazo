import type { ComputerRef } from "@rakazo/adapter-kit";
import {
  COMPUTER_DAMAGED_ERROR,
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_RATE_LIMIT_ERROR,
  COMPUTER_RECOVERY_REQUIRED_ERROR,
  COMPUTER_START_FAILED_ERROR,
  COMPUTER_UNRESPONSIVE_ERROR,
  isComputerAllowanceUsed,
} from "@rakazo/contracts";
import { ComputerRecoveryRequiredError } from "../../computers/computer-lifecycle.js";
import { isSandboxDamagedError } from "../../computers/sandbox/sandbox-errors.js";

const COMPUTER_RUN_ERRORS = new Set([
  COMPUTER_RATE_LIMIT_ERROR,
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_UNRESPONSIVE_ERROR,
  COMPUTER_START_FAILED_ERROR,
]);

/** The computer cannot be used until its owner recovers it, so trying again cannot help. */
export function computerNeedsRecovery(error: unknown): boolean {
  if (error instanceof ComputerRecoveryRequiredError || isSandboxDamagedError(error)) return true;
  return error instanceof AggregateError && error.errors.some(computerNeedsRecovery);
}

/** What a run says when its computer failed, so the failure is never taken for the model's. */
export function computerRunError(error: unknown): string {
  if (error instanceof ComputerRecoveryRequiredError) return COMPUTER_RECOVERY_REQUIRED_ERROR;
  if (computerNeedsRecovery(error)) return COMPUTER_DAMAGED_ERROR;
  const message = error instanceof Error ? error.message : "";
  return COMPUTER_RUN_ERRORS.has(message) || isComputerAllowanceUsed(message)
    ? message
    : COMPUTER_START_FAILED_ERROR;
}

/** The run's computer failed to start; setup tries again, under the computer's own message. */
export class RunComputerFailedError extends Error {
  constructor(readonly computerError: unknown) {
    super(computerRunError(computerError), { cause: computerError });
    this.name = "RunComputerFailedError";
  }
}

/**
 * A run's computer, started the first time a tool needs it.
 *
 * Remote computers bill while they run, so a run that never touches its computer must not
 * create or resume one. A failed start is kept: every later use rethrows it as a setup failure.
 */
export function lazyRunComputer(start: () => Promise<ComputerRef>, onFailure?: () => void) {
  let started: Promise<ComputerRef> | undefined;
  let ready: ComputerRef | undefined;
  let failed = false;
  let failure: unknown;
  return {
    get(): Promise<ComputerRef> {
      started ??= start().then(
        (computer) => {
          ready = computer;
          return computer;
        },
        (error: unknown) => {
          failed = true;
          failure = error;
          onFailure?.();
          throw error;
        },
      );
      return started;
    },
    /** The computer if a tool already started it. */
    get ready(): ComputerRef | undefined {
      return ready;
    },
    throwIfFailed(): void {
      if (failed) throw failure;
    },
  };
}
