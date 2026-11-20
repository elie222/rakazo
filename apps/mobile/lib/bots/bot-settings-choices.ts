import { useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { useMemo } from "react";
import type { MenuPickerChoice } from "../../components/ui/menu-picker";
import { thinkingLevelLabel } from "../models/thinking-level";

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
  const { t } = useLingui();
  return useMemo(
    () => [
      { key: "space", label: t`Space default` },
      { key: "ask", label: t`Ask` },
      { key: "auto", label: t`Auto` },
      { key: "never", label: t`Never ask` },
    ],
    [t],
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
