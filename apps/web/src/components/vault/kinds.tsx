import { useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata } from "@rakazo/contracts";
import { cardExpiry, commandVariableName } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import { Braces, CreditCard, KeyRound, MapPin, SquareTerminal } from "lucide-react";

export type VaultAuth = NonNullable<BotSecretMetadata["auth"]>;

/** What people pick from New: API credentials of every kind are one "API key". */
export type VaultKind = "login" | "card" | "contact" | "api_key" | "variable";
export const VAULT_KINDS: readonly VaultKind[] = [
  "login",
  "card",
  "contact",
  "api_key",
  "variable",
];

export function vaultKind(auth: Pick<VaultAuth, "type">): VaultKind {
  if (auth.type === "login" || auth.type === "card" || auth.type === "contact") return auth.type;
  if (auth.type === "command") return "variable";
  return "api_key";
}

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
        "grid size-9 shrink-0 place-items-center rounded-[10px] text-[14px] font-semibold",
        letter ? "bg-foreground text-background" : "bg-accent text-foreground",
        className,
      )}
    >
      {letter ?? <Icon className="size-4" />}
    </span>
  );
}

/** The line under an item's title: what tells two of a kind apart at a glance. */
export function useVaultSubtitle() {
  const { t } = useLingui();
  const { one } = useVaultKindLabels();
  return (item: BotSecretMetadata): string => {
    if (!item.auth) return "";
    const { preview } = item;
    switch (vaultKind(item.auth)) {
      case "login": {
        // A login without its own title is already titled by its site.
        const host = siteHost(item.origin).replace(/^www\./, "");
        return [preview?.username, item.title === host ? undefined : host]
          .filter(Boolean)
          .join(" · ");
      }
      case "card": {
        const expiry = preview?.card ? cardExpiry(preview.card) : undefined;
        return [expiry ? t`Expires ${expiry}` : undefined, item.note || undefined]
          .filter(Boolean)
          .join(" · ");
      }
      case "contact": {
        const contact = preview?.contact;
        if (!contact) return "";
        return [
          contact.name && contact.name !== item.title ? contact.name : undefined,
          contact.city ?? contact.line1,
          contact.phone,
          contact.email,
        ]
          .filter(Boolean)
          .slice(0, 2)
          .join(" · ");
      }
      case "api_key": {
        const host = siteHost(item.origin);
        return item.title === host ? one.api_key : [one.api_key, host].join(" · ");
      }
      case "variable":
        return `$${commandVariableName(item.name)}`;
    }
  };
}
