import { COMPUTER_RATE_LIMIT_ERROR } from "@rakazo/contracts";

/** The sandbox provider refused the request because an account rate limit or quota was hit. */
export class SandboxRateLimitError extends Error {
  readonly code = "SANDBOX_RATE_LIMITED";
  constructor(options?: { cause?: unknown }) {
    super(COMPUTER_RATE_LIMIT_ERROR, options);
    this.name = "SandboxRateLimitError";
  }
}

/**
 * The sandbox took a request but did not answer before the provider gave up on it. It is not
 * resent; background work skips this attempt and tries again later.
 */
export class SandboxUnresponsiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnresponsiveError";
  }
}

/** The provider accepted the start but did not bring the computer up in time; a retry may work. */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(options?: { cause?: unknown }) {
    super("The computer did not start. Try again.", options);
    this.name = "SandboxUnavailableError";
  }
}
