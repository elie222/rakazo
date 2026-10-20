/** The sandbox provider refused the request because an account rate limit or quota was hit. */
export class SandboxRateLimitError extends Error {
  readonly code = "SANDBOX_RATE_LIMITED";
  constructor(options?: { cause?: unknown }) {
    super("Too many computer requests. Try again later.", options);
    this.name = "SandboxRateLimitError";
  }
}
