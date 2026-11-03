import type {
  BotSecretMetadata,
  CardSummary,
  ContactFields,
  LoginFieldInput,
  VaultKind,
  VaultRevealed,
} from "@rakazo/contracts";
import {
  BotSecretName,
  CardSecretValue,
  CONTACT_FIELDS,
  ContactSecretValue,
  cardBrand,
  cardExpiry,
  commandVariableName,
  commandVariableProblem,
  encodeCardSecret,
  encodeContactSecret,
  encodeLoginSecret,
  LoginSecretValue,
  parseCardExpiry,
  vaultItemSubtitle as sharedSubtitle,
  VAULT_KINDS,
  vaultKind,
} from "@rakazo/contracts";
import { t } from "./i18n";

export type CredentialAuth = NonNullable<BotSecretMetadata["auth"]>;
export type CredentialType = CredentialAuth["type"];
export type VaultItem = BotSecretMetadata & { auth: CredentialAuth };
/** What a save sends: no name for a new item, which the server names from its title. */
export type VaultDestination = { name?: string; origin?: string; auth: CredentialAuth };

export function vaultKindLabel(kind: VaultKind): string {
  if (kind === "login") return t("Login");
  if (kind === "card") return t("Card");
  if (kind === "contact") return t("Contact");
  if (kind === "api_key") return t("API key");
  return t("Variable");
}

/** The SF Symbol and Ionicons fallback for a kind. */
export function vaultKindSymbol(kind: VaultKind): { ios: string; android: string } {
  if (kind === "login") return { ios: "key", android: "key-outline" };
  if (kind === "card") return { ios: "creditcard", android: "card-outline" };
  if (kind === "contact") return { ios: "mappin.and.ellipse", android: "location-outline" };
  if (kind === "api_key")
    return { ios: "chevron.left.forwardslash.chevron.right", android: "code-slash" };
  return { ios: "terminal", android: "terminal-outline" };
}

/** A saved item that can be edited: its settings still read and its name still saves. */
export function readableItem(item: BotSecretMetadata): VaultItem | null {
  return item.auth !== null && BotSecretName.safeParse(item.name).success
    ? { ...item, auth: item.auth }
    : null;
}

/** The muted line under an item's title, the same as on web; an unreadable one shows its site. */
export function vaultItemSubtitle(item: BotSecretMetadata): string {
  if (!item.auth) return item.origin;
  return sharedSubtitle(item, {
    apiKey: t("API key"),
    expires: (date) => t("Expires {date}", { date }),
  });
}

/** The items a kind filter and a search keep, in the list's order. */
export function filterVaultItems(
  items: readonly BotSecretMetadata[],
  kind: VaultKind | "all",
  query: string,
): BotSecretMetadata[] {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (kind === "all" || (item.auth && vaultKind(item.auth.type) === kind)) &&
      (!needle || `${item.title} ${vaultItemSubtitle(item)}`.toLowerCase().includes(needle)),
  );
}

/** The kinds present, in the menu's order: the filter shows only once there are two. */
export function vaultKindsPresent(items: readonly BotSecretMetadata[]): VaultKind[] {
  const present = new Set(items.flatMap((item) => (item.auth ? [vaultKind(item.auth.type)] : [])));
  return VAULT_KINDS.filter((kind) => present.has(kind));
}

/** A search box helps only in a long list. */
export const VAULT_SEARCH_MIN_ITEMS = 8;

/** Puts a saved item in the list, replacing the one with its name. */
export function withItem(
  list: readonly BotSecretMetadata[],
  saved: BotSecretMetadata,
): BotSecretMetadata[] {
  return list.some((entry) => entry.name === saved.name)
    ? list.map((entry) => (entry.name === saved.name ? saved : entry))
    : [...list, saved];
}

// ---- Editing ----

export type ApiAuthType = "bearer" | "header" | "basic";

/** Everything the editor collects. Protected values live only in the editor's state. */
export type VaultDraft = {
  title: string;
  note: string;
  origin: string;
  /** A variable's name, as people type it: DEPLOY_TOKEN. */
  variable: string;
  apiAuth: ApiAuthType;
  headerName: string;
  basicUsername: string;
  value: string;
  fields: readonly LoginFieldInput[];
  number: string;
  expiry: string;
  cvc: string;
  cardName: string;
  billing: string;
  contact: Record<keyof ContactFields, string>;
};

const EMPTY_CONTACT = Object.fromEntries(CONTACT_FIELDS.map((field) => [field, ""])) as Record<
  keyof ContactFields,
  string
>;

export function emptyDraft(fields: readonly LoginFieldInput[] = []): VaultDraft {
  return {
    title: "",
    note: "",
    origin: "",
    variable: "",
    apiAuth: "bearer",
    headerName: "",
    basicUsername: "",
    value: "",
    fields,
    number: "",
    expiry: "",
    cvc: "",
    cardName: "",
    billing: "",
    contact: EMPTY_CONTACT,
  };
}

/** The editor's starting state for a saved item: its labels and what its preview shows. */
/**
 * The form for a saved item. A login or card starts from its revealed value, so a save sends every
 * field as it is now instead of only the ones typed again.
 */
export function itemDraft(
  item: VaultItem,
  fields: readonly LoginFieldInput[],
  revealed?: VaultRevealed,
): VaultDraft {
  const draft = emptyDraft(revealed && "fields" in revealed ? revealed.fields : fields);
  const card = revealed && "card" in revealed ? revealed.card : undefined;
  return {
    ...draft,
    title: item.title,
    note: item.note,
    origin: item.origin,
    variable: commandVariableName(item.name),
    ...(card
      ? {
          number: card.number,
          expiry: cardExpiry(card),
          cvc: card.cvc ?? "",
          cardName: card.name ?? "",
          billing: card.billing ?? "",
        }
      : {}),
    contact: { ...EMPTY_CONTACT, ...stringFields(item.preview?.contact) },
  };
}

function stringFields(
  contact: ContactFields | undefined,
): Partial<Record<keyof ContactFields, string>> {
  return Object.fromEntries(Object.entries(contact ?? {}).filter(([, value]) => value)) as Partial<
    Record<keyof ContactFields, string>
  >;
}

export function apiAuth(draft: VaultDraft): CredentialAuth {
  if (draft.apiAuth === "header") return { type: "header", name: draft.headerName.trim() };
  if (draft.apiAuth === "basic") return { type: "basic", username: draft.basicUsername.trim() };
  return { type: "bearer" };
}

/** A variable's saved name: DEPLOY_TOKEN is saved as deploy_token and exported as $DEPLOY_TOKEN. */
export function variableName(draft: VaultDraft): string {
  return draft.variable.trim().toLowerCase();
}

/** Why the typed variable name cannot be saved, once there is one. */
export function variableProblem(draft: VaultDraft): "invalid" | "reserved" | undefined {
  const name = variableName(draft);
  if (!name) return undefined;
  if (!BotSecretName.safeParse(name).success) return "invalid";
  return commandVariableProblem(commandVariableName(name)) ? "reserved" : undefined;
}

export function cardValue(draft: VaultDraft) {
  const expiry = parseCardExpiry(draft.expiry);
  if (!expiry) return undefined;
  return CardSecretValue.safeParse({
    number: draft.number,
    ...expiry,
    cvc: draft.cvc,
    name: draft.cardName,
    ...(draft.billing ? { billing: draft.billing } : {}),
  }).data;
}

export function contactValue(draft: VaultDraft) {
  return ContactSecretValue.safeParse(draft.contact).data;
}

/** The brand a typed number belongs to, once there are enough digits to tell. */
export function typedCardBrand(number: string): string | undefined {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 2) return undefined;
  const brand = cardBrand(digits);
  return brand === "Card" ? undefined : brand;
}

/**
 * The value a save sends for a kind, or undefined when the draft has none to send. A saved login,
 * card, key or variable keeps its value until a new one is typed; a contact always sends its fields.
 */
export function draftValue(kind: VaultKind, draft: VaultDraft): string | undefined {
  if (kind === "login") {
    const fields = draft.fields.map(({ label, value, hidden }) => ({ label, value, hidden }));
    return LoginSecretValue.safeParse({ fields }).success
      ? encodeLoginSecret({ fields })
      : undefined;
  }
  if (kind === "card") {
    const card = cardValue(draft);
    return card ? encodeCardSecret(card) : undefined;
  }
  if (kind === "contact") {
    const contact = contactValue(draft);
    return contact ? encodeContactSecret(contact) : undefined;
  }
  return draft.value.length > 0 ? draft.value : undefined;
}

/**
 * Whether a save sends a value. A contact, login or card always does: the form holds all of it,
 * a login's and card's revealed before editing. An API key or variable is never shown in the form,
 * so it keeps its value until a new one is typed, and a save without one changes only the labels.
 */
export function valueStarted(kind: VaultKind, draft: VaultDraft): boolean {
  if (kind === "contact" || kind === "login" || kind === "card") return true;
  return draft.value.length > 0;
}

/** What a new item of a kind saves to: everything but its value. */
export function draftDestination(kind: VaultKind, draft: VaultDraft): VaultDestination {
  if (kind === "login") return { origin: draft.origin.trim(), auth: { type: "login" } };
  if (kind === "api_key") return { origin: draft.origin.trim(), auth: apiAuth(draft) };
  if (kind === "variable") return { name: variableName(draft), auth: { type: "command" } };
  return { auth: { type: kind } };
}

/** A saved item's destination, which an edit never changes. */
export function itemDestination(item: VaultItem): VaultDestination {
  return vaultKind(item.auth.type) === "variable" ||
    item.auth.type === "card" ||
    item.auth.type === "contact"
    ? { name: item.name, auth: item.auth }
    : { name: item.name, origin: item.origin, auth: item.auth };
}

export type VaultSave = {
  destination: VaultDestination;
  value?: string;
  title?: string;
  note?: string;
};

/** What Save sends, or undefined while the draft can't be saved. */
export function draftSave(
  kind: VaultKind,
  draft: VaultDraft,
  saved?: VaultItem,
): VaultSave | undefined {
  // A title is sent only when it changed: a saved item shows one read from it when it has none of
  // its own, and keeping that would freeze it when the card or contact changes later.
  const title = draft.title.trim();
  const labels = {
    ...(title !== (saved?.title ?? "") ? { title } : {}),
    note: draft.note.trim(),
  };
  if (saved) {
    if (!valueStarted(kind, draft)) return { destination: itemDestination(saved), ...labels };
    const value = draftValue(kind, draft);
    return value === undefined
      ? undefined
      : { destination: itemDestination(saved), value, ...labels };
  }
  const value = draftValue(kind, draft);
  if (value === undefined) return undefined;
  if ((kind === "login" || kind === "api_key") && !draft.origin.trim()) return undefined;
  if (kind === "api_key" && draft.apiAuth === "header" && !draft.headerName.trim())
    return undefined;
  if (kind === "api_key" && draft.apiAuth === "basic" && !draft.basicUsername.trim())
    return undefined;
  if (kind === "variable" && (!variableName(draft) || variableProblem(draft))) return undefined;
  return { destination: draftDestination(kind, draft), value, ...labels };
}

/** A contact's title as the card billing menu shows it. */
export function billingChoices(items: readonly BotSecretMetadata[]) {
  return items
    .filter((item) => item.auth?.type === "contact")
    .map((item) => ({ key: item.name, label: item.title }));
}

/** The rows a saved card's detail shows from its summary. */
export function cardRows(card: CardSummary) {
  return { number: `•••• ${card.last4}`, expires: cardExpiry(card) };
}
