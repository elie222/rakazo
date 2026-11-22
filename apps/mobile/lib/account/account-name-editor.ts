import { t } from "@lingui/core/macro";
import type { Alert } from "react-native";

import { lengthLimitMessage, promptText } from "../dialogs/text-prompt";

type Dependencies<T> = {
  currentName: string;
  pending: { current: boolean };
  saveVersion: { current: number };
  Platform: { OS: string };
  Alert: Pick<typeof Alert, "prompt">;
  errorText: (error: unknown, fallback: string) => string;
  updateAccountName: (name: string) => Promise<void>;
  refresh: () => Promise<T>;
  onSaved: (name: string) => void;
  onRefreshed: (account: T) => void;
  setNameDraft: (value: string) => void;
  setNameError: (error: string | null) => void;
  setNamePending: (pending: boolean) => void;
  setNameDialogOpen: (open: boolean) => void;
};

export function createAccountNameEditor<T>(deps: Dependencies<T>) {
  const { pending } = deps;
  function prompt(value: string, message?: string) {
    promptText(deps.Alert, {
      title: t`Edit name`,
      message,
      value,
      onSave: (draft) => saveName(draft ?? ""),
    });
  }

  async function saveName(value: string) {
    if (pending.current) return;
    const name = value.trim();
    if (!name || name === deps.currentName) {
      deps.setNameDialogOpen(false);
      return;
    }
    if (name.length > 80) {
      const message = lengthLimitMessage(80);
      if (deps.Platform.OS === "ios") prompt(value, message);
      else deps.setNameError(message);
      return;
    }
    pending.current = true;
    deps.setNamePending(true);
    deps.setNameError(null);
    let failure: string | undefined;
    try {
      await deps.updateAccountName(name);
      const version = ++deps.saveVersion.current;
      deps.onSaved(name);
      deps.setNameDialogOpen(false);
      void deps
        .refresh()
        .then((account) => {
          if (version === deps.saveVersion.current) deps.onRefreshed(account);
        })
        .catch(() => undefined);
    } catch (error) {
      failure = deps.errorText(error, t`Could not update name`);
      if (deps.Platform.OS !== "ios") deps.setNameError(failure);
    } finally {
      pending.current = false;
      deps.setNamePending(false);
    }
    if (failure && deps.Platform.OS === "ios") prompt(value, failure);
  }

  function editName() {
    if (pending.current) return;
    if (deps.Platform.OS === "ios") prompt(deps.currentName);
    else {
      deps.setNameDraft(deps.currentName);
      deps.setNameError(null);
      deps.setNameDialogOpen(true);
    }
  }

  function closeNameDialog() {
    if (!pending.current) deps.setNameDialogOpen(false);
  }
  return { editName, saveName, closeNameDialog };
}
