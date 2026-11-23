import { useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { approvalModeLabel } from "@rakazo/i18n/approval-mode";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import { useMemo } from "react";
import type { MenuPickerChoice } from "../../components/ui/menu-picker";

/** The thinking-level rows, with the default first. */
export function useThinkingChoices(options: readonly ThinkingLevel[]): MenuPickerChoice[] {
  const { t } = useLingui();
  return useMemo(
    () => [
      { key: "", label: t`Default` },
      ...options.map((level) => ({ key: level, label: thinkingLevelLabel(level) })),
    ],
    [t, options],
  );
}

/** The bot's own approval-mode rows, the Space's default first. */
export function useApprovalModeChoices(): MenuPickerChoice[] {
  return useMemo(
    () => [
      { key: "space", label: approvalModeLabel("space") },
      { key: "ask", label: approvalModeLabel("ask") },
      { key: "auto", label: approvalModeLabel("auto") },
      { key: "never", label: approvalModeLabel("never") },
    ],
    [],
  );
}

/** How soon this bot compacts older messages. */
export function useConversationCompactionChoices(): MenuPickerChoice[] {
  const { t } = useLingui();
  return useMemo(
    () => [
      { key: "automatic", label: t`Automatic (default)` },
      { key: "earlier", label: t`Earlier` },
      { key: "near_limit", label: t`Near the limit` },
      { key: "custom", label: t`Custom amount` },
    ],
    [t],
  );
}
