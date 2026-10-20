// Provider wording for a sandbox that no longer exists, for errors that lost their name.
const SANDBOX_GONE_MESSAGE = /sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;

/**
 * Only provider evidence of sandbox loss permits automatic replacement. Adapters report it by
 * throwing an error named `SandboxNotFoundError`.
 */
export function isSandboxGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}
