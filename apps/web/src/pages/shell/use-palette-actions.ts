import { useLingui } from "@lingui/react/macro";
import type { Me } from "@rakazo/contracts";
import {
  Import,
  Keyboard,
  LayoutTemplate,
  Lock,
  Monitor,
  Moon,
  Plug,
  Plus,
  ScrollText,
  Sun,
  Users,
} from "lucide-react";
import { computersAreUnavailable } from "../../lib/computers/computer-sandbox";
import { desktopBridge } from "../../lib/platform/desktop";
import type { AppearancePreference } from "../../lib/preferences/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../../lib/preferences/ui-appearance";
import { useSettingsNavItems } from "../settings/settings-nav";
import type { CommandPaletteAction } from "./command-palette";
import type { SettingsSection, ShellOverlay } from "./shell-overlay-url";

/** What the command menu offers: create, connect, settings sections, and appearance. */
export function usePaletteActions({
  me,
  messagingEnabled,
  onNewBot,
  onNewGroup,
  onNewSpace,
  onShortcuts,
  setOverlay,
  openSettings,
}: {
  me: Me | null | undefined;
  messagingEnabled: boolean;
  onNewBot: () => void;
  onNewGroup: () => void;
  onNewSpace: () => void;
  onShortcuts: () => void;
  setOverlay: (overlay: ShellOverlay) => void;
  openSettings: (section: SettingsSection) => void;
}): CommandPaletteAction[] {
  const { t } = useLingui();
  const settingsNavItems = useSettingsNavItems({
    messaging: messagingEnabled,
    wallet: Boolean(me?.paymentWalletProvider),
    computer: me?.computerSettingsEnabled === true && computersAreUnavailable(me?.sandboxProvider),
    billing: me?.billingEnabled === true,
    updates: Boolean(desktopBridge()?.update),
    labs: Boolean(me?.labsAvailable.length),
  });
  return [
    {
      id: "new-bot",
      label: t`New bot`,
      icon: Plus,
      onSelect: onNewBot,
    },
    {
      id: "new-group",
      label: t`New group chat`,
      icon: Users,
      onSelect: onNewGroup,
    },
    {
      id: "new-space",
      label: t`New private space`,
      icon: Lock,
      onSelect: onNewSpace,
    },
    {
      id: "integrations",
      label: t`Connect apps`,
      icon: Plug,
      onSelect: () => setOverlay({ kind: "integrations" }),
    },
    {
      id: "bot-templates",
      label: t`Bot templates`,
      icon: LayoutTemplate,
      onSelect: () => setOverlay({ kind: "templates" }),
    },
    {
      id: "import-agent",
      label: t`Import an agent`,
      icon: Import,
      onSelect: () => setOverlay({ kind: "import" }),
    },
    {
      id: "keyboard-shortcuts",
      label: t`Keyboard shortcuts`,
      icon: Keyboard,
      onSelect: onShortcuts,
    },
    {
      id: "skills",
      label: t`Skills`,
      icon: ScrollText,
      onSelect: () => setOverlay({ kind: "skills" }),
    },
    ...settingsNavItems.map(({ id, label, icon }) => ({
      id: `settings-${id}`,
      label: t`Settings: ${label}`,
      icon,
      onSelect: () => openSettings(id),
    })),
    ...(
      [
        { value: "system", label: t`System`, icon: Monitor },
        { value: "light", label: t`Light`, icon: Sun },
        { value: "dark", label: t`Dark`, icon: Moon },
      ] satisfies { value: AppearancePreference; label: string; icon: typeof Sun }[]
    ).map(({ value, label, icon }) => ({
      id: `appearance-${value}`,
      label: t`Appearance: ${label}`,
      icon,
      checked: getUiAppearancePreference() === value,
      onSelect: () => setUiAppearance(value),
    })),
  ];
}
