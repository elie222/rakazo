import { fileURLToPath } from "node:url";

/** One fixed model unless the caller picks one, so results do not depend on a local .env. */
export const DEFAULT_EVAL_MODEL = {
  provider: "openrouter",
  model: "anthropic/claude-haiku-5.5",
  apiKeyEnv: "OPENROUTER_API_KEY",
  pricing: fileURLToPath(
    new URL("./fixtures/pricing-openrouter-haiku-5.5-2026-10-27.json", import.meta.url),
  ),
};
