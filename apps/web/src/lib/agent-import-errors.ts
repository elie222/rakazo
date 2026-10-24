import { t } from "@lingui/core/macro";
import { agentImportErrorReason } from "@rakazo/contracts";

/**
 * Copy for an import or Undo the server refused, chosen by the reason it sends (its message
 * is English). Undefined for anything else, which `errorText` handles as before.
 */
export function agentImportErrorText(error: unknown): string | undefined {
  switch (agentImportErrorReason(error)) {
    case "selection_mismatch":
      return t`These files changed. Choose them again.`;
    case "cannot_run_here":
      return t`Something you chose cannot work here. Untick it and try again.`;
    case "model_needs_key":
      return t`Connect this model's provider first.`;
    case "instructions_too_long":
      return t`Instructions are too long. Untick some files.`;
    case "import_reused":
      return t`This import was already used. Choose the files again.`;
    case "name_required":
      return t`Name this bot`;
    case "first_bot_exists":
      return t`Your first bot already exists.`;
    case "instructions_changed":
      return t`Its instructions changed. Review them, then try again.`;
    case "name_just_taken":
      return t`Something with the same name was just added. Try again.`;
    case "not_imported":
      return t`This bot was not imported.`;
    case "import_changed":
      return t`This import changed. Try again.`;
    default:
      // `first_bot_new_only` cannot come from this app's forms.
      return undefined;
  }
}
