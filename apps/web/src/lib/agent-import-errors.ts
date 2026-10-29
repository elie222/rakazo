import { t } from "@lingui/core/macro";
import { agentImportErrorReason } from "@rakazo/contracts";
import { translateRunError } from "./run-error";

function errorProvider(error: unknown): string {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const provider = data && typeof data === "object" && "provider" in data ? data.provider : "";
  return typeof provider === "string" && provider
    ? provider
    : translateRunError("Your model provider");
}

/** Localized copy for a refused import; undefined for other errors. */
export function agentImportErrorText(error: unknown): string | undefined {
  switch (agentImportErrorReason(error)) {
    case "selection_mismatch":
      return t`These files or choices no longer match. Choose the files again.`;
    case "cannot_run_here":
      return t`Something you chose cannot work here. Untick it and try again.`;
    case "model_needs_key":
      return t`Connect this model's provider first.`;
    case "instructions_too_long":
      return t`Instructions are too long. Untick some files.`;
    case "import_reused":
      return t`This import was already used. Choose the files again.`;
    case "name_just_taken":
      return t`Something with the same name was just added. Try again.`;
    case "key_rejected":
      // The same words, and translations, as when a connected key is rejected in a chat.
      return translateRunError("{provider} rejected the API key. Check your connection settings.", {
        provider: errorProvider(error),
      });
    case "key_unverified":
      return t`An imported API key could not be checked. Try again.`;
    case "key_check_failed":
      return t`An imported API key could not be used. Untick it and try again.`;
    default:
      return undefined;
  }
}
