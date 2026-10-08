import type { CommandRequest } from "@rakazo/adapter-kit";

/** Unsets win over both inherited and explicitly supplied values. */
export function sandboxCommandEnvironment(
  request: Pick<CommandRequest, "env" | "unsetEnv">,
  inherited: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env = { ...inherited, ...request.env };
  for (const name of request.unsetEnv ?? []) {
    delete env[name];
    // Windows environment names are case-insensitive, including inherited host names.
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      }
    }
  }
  return env;
}

/** Linux providers overlay env through their SDK; remove inherited values in the child. */
export function sandboxCommandArgv(request: CommandRequest): string[] {
  if (!request.unsetEnv?.length) return request.argv;
  return ["env", ...request.unsetEnv.flatMap((name) => ["-u", name]), "--", ...request.argv];
}
