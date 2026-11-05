import { useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata, VaultKind } from "@rakazo/contracts";
import { vaultItemSubtitle } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import { Braces, CreditCard, KeyRound, MapPin, SquareTerminal } from "lucide-react";

export type VaultAuth = NonNullable<BotSecretMetadata["auth"]>;

const KIND_ICONS: Record<VaultKind, LucideIcon> = {
  login: KeyRound,
  card: CreditCard,
  contact: MapPin,
  api_key: Braces,
  variable: SquareTerminal,
};

export function useVaultKindLabels() {
  const { t } = useLingui();
  const one: Record<VaultKind, string> = {
    login: t`Login`,
    card: t`Card`,
    contact: t`Contact`,
    api_key: t`API key`,
    variable: t`Variable`,
  };
  const many: Record<VaultKind, string> = {
    login: t`Logins`,
    card: t`Cards`,
    contact: t`Contacts`,
    api_key: t`Keys`,
    variable: t`Variables`,
  };
  return { one, many };
}

export function siteHost(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).host.replace(/^www\./, "") : origin;
}

/**
 * An item's icon. A login shows its site's first letter on an inverted plate, as a site's own mark
 * would stand out; everything else shows its kind.
 */
export function VaultTile({
  kind,
  title,
  className,
}: {
  kind: VaultKind | null;
  title: string;
  className?: string;
}) {
  const Icon = kind ? KIND_ICONS[kind] : KeyRound;
  const letter = kind === "login" ? Array.from(title.trim())[0]?.toUpperCase() : undefined;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md text-[14px] font-semibold",
        letter ? "bg-foreground text-background" : "bg-accent text-foreground",
        className,
      )}
    >
      {letter ?? <Icon className="size-4" />}
    </span>
  );
}

/** The line under an item's title, the same on every surface. */
export function useVaultSubtitle() {
  const { t } = useLingui();
  const { one } = useVaultKindLabels();
  return (item: BotSecretMetadata): string =>
    vaultItemSubtitle(item, { apiKey: one.api_key, expires: (expiry) => t`Expires ${expiry}` });
}
