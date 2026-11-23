import { createCodingCliConnection } from "@rakazo/adapters";
import type { AppEnv } from "./env.js";

/** The composition root binds the validated app env to the computer coding CLI connection. */
export function createCodingCliFromEnv(env: AppEnv) {
  return createCodingCliConnection({
    CODING_CLI_PROVIDER: env.codingCliProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CODING_CLI_BIN: process.env.CODING_CLI_BIN,
  });
}
