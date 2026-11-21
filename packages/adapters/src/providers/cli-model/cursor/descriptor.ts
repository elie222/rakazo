/** Env variable the vendor CLI reads for its API key. */
export const CURSOR_COMPUTER_CLI_API_KEY_ENV = "CURSOR_API_KEY";

/** One argv token. Default `agent` when unset. */
export function cursorComputerCliBin(source: NodeJS.ProcessEnv = process.env): string {
  return source.CODING_CLI_BIN?.trim() || "agent";
}

export function assertCursorComputerCliBin(source: NodeJS.ProcessEnv, enabled: boolean): string {
  const raw = cursorComputerCliBin(source);
  if (enabled && /\s/.test(raw)) throw new Error("CODING_CLI_BIN must not contain spaces");
  return raw;
}
