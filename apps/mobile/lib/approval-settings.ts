import type { ActionAutoReviewSettings, ApprovalMode } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { useI18n } from "./i18n";
import type { SettingsTarget } from "./settings-target";
import { settingsRpc } from "./settings-target";
import { errorText } from "./user-error";

export type ApprovalSettings = {
  settings: ActionAutoReviewSettings | null;
  ruleCount: number;
  loadError: string | null;
  pending: boolean;
  setMode: (mode: ApprovalMode) => Promise<void>;
  retry: () => void;
};

/**
 * The approval mode and the number of saved rules, for the Approvals rows in settings. Reads
 * again whenever the screen regains focus, so the count follows rules removed on the rules list.
 * Without `enabled` (a Space that follows the account) nothing is read.
 */
export function useApprovalSettings(target: SettingsTarget, enabled = true): ApprovalSettings {
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const [settings, setSettings] = useState<ActionAutoReviewSettings | null>(null);
  const [ruleCount, setRuleCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Counts saves, so a read that started before one never shows what it replaced.
  const saves = useRef(0);
  // Set before the first await, so a second pick in the same frame can't start another save.
  const saving = useRef(false);
  // A read wanted while a save runs could return the mode being replaced, so it waits for the save.
  const readAfterSave = useRef(false);
  // Counts the times a Space went back to following the account, so a save from before is dropped.
  const resets = useRef(0);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) {
        resets.current += 1;
        setSettings(null);
        setRuleCount(0);
        setLoadError(null);
        return;
      }
      if (saving.current) {
        readAfterSave.current = true;
        return;
      }
      let current = true;
      const savesAtRead = saves.current;
      void Promise.all([rpc("autoReview/get", { scope }), rpc("approvalRules/list", { scope })])
        .then(([nextSettings, rules]) => {
          if (!current) return;
          // A save doesn't change the rules, so a read it overtook still brings a fresh count.
          setRuleCount(rules.length);
          if (saves.current !== savesAtRead) return;
          setSettings(nextSettings);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current && saves.current === savesAtRead)
            setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [attempt, enabled, rpc, scope, t]),
  );

  async function setMode(mode: ApprovalMode) {
    if (!settings || saving.current || mode === settings.mode) return;
    const previous = settings;
    const resetsAtSave = resets.current;
    saves.current += 1;
    saving.current = true;
    setPending(true);
    setSettings({ ...previous, mode });
    try {
      const saved = await rpc("autoReview/set", { scope, mode });
      if (resets.current === resetsAtSave) setSettings(saved);
    } catch (err) {
      if (resets.current === resetsAtSave) setSettings(previous);
      Alert.alert(t("Could not save that preference"), errorText(err, t("Try again.")));
      // The save may have landed before the reply was lost, so read what is actually stored.
      readAfterSave.current = true;
    } finally {
      saving.current = false;
      setPending(false);
      if (readAfterSave.current) {
        readAfterSave.current = false;
        setAttempt((count) => count + 1);
      }
    }
  }

  const retry = () => {
    setLoadError(null);
    setAttempt((count) => count + 1);
  };

  return { settings, ruleCount, loadError, pending, setMode, retry };
}
