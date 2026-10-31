import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Gauge,
  KeyRound,
  MessageCircle,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

/** The settings sections this deployment offers, in nav order; Space opens from its own menu. */
export function useSettingsNavItems(available: {
  messaging: boolean;
  wallet: boolean;
  computer: boolean;
  billing: boolean;
  updates: boolean;
}): SettingsNavItem[] {
  const { t } = useLingui();
  return [
    { id: "general", label: t`General`, icon: Settings },
    { id: "models", label: t`Models`, icon: Cpu },
    { id: "voice", label: t`Voice`, icon: Volume2 },
    { id: "confirmations", label: t`Approvals`, icon: ShieldCheck },
    { id: "vault", label: t`Vault`, icon: KeyRound },
    ...(available.messaging
      ? [{ id: "messaging" as const, label: t`Messaging`, icon: MessageCircle }]
      : []),
    ...(available.wallet ? [{ id: "wallet" as const, label: t`Wallet`, icon: Wallet }] : []),
    { id: "memory", label: t`Memory`, icon: Brain },
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(available.computer ? [{ id: "computer" as const, label: t`Computer`, icon: Monitor }] : []),
    ...(available.billing ? [{ id: "billing" as const, label: t`Billing`, icon: CreditCard }] : []),
    ...(available.updates
      ? [{ id: "updates" as const, label: t`Updates`, icon: CloudDownload }]
      : []),
  ];
}
