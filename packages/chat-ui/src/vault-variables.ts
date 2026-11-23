import { createContext, useContext, useEffect } from "react";
import { rewriteOutsideCode } from "./markdown";

/**
 * The viewer's own Vault command variables and what tapping one in a message does. The app reads
 * them only once a message on screen could name one.
 */
export type VaultVariables = {
  /**
   * Asks the app to read the viewer's variables, with the names of the saved placeholders the text
   * holds: one the Vault as read doesn't have may have been saved since, so it is read again.
   */
  want(saved: readonly string[]): void;
  /** Each `$NAME` the viewer's Vaults export, once read. */
  names: ReadonlySet<string> | undefined;
  /** Opens the viewer's Vault at the item exported as `$name`. */
  open(name: string): void;
  /** Tells the viewer they can't open a Vault secret a message names. */
  denied(): void;
  /** The accessible name of a link that opens `$NAME`, given as written. */
  openLabel(variable: string): string;
};

/** The Vault variables of the messages and pages drawn below; without it `$NAME` stays text. */
export const VaultVariablesContext = createContext<VaultVariables | null>(null);

/** A `$NAME` drawn as a Vault link: the viewer's own item, or a secret they can't open. */
export type VaultVariableLink = { name: string; denied: boolean };
export type VaultVariablePart = string | VaultVariableLink;

const MAY_NAME_VARIABLE = /\$[A-Za-z_]/;
// Not part of a longer word, a `$$` or an escaped `\$`.
const VARIABLE = /(^|[^\p{L}\p{N}_$\\])\$([A-Za-z_][A-Za-z0-9_]*)(?![\p{L}\p{N}_])/gu;
// What the server writes where it took a pasted value out of a message and saved it to its
// author's Vault. It marks the name as a Vault secret, also for a reader who can't open it.
const SAVED_PLACEHOLDER_OPEN = "[saved as ";
const SAVED_PLACEHOLDER = /\[saved as \$([A-Za-z_][A-Za-z0-9_]*)\]/g;

/** The chat's Vault variables once they are read, asked for when this text could name one. */
export function useVaultVariables(text: string): VaultVariables | null {
  const vault = useContext(VaultVariablesContext);
  const mayName = vault !== null && MAY_NAME_VARIABLE.test(text);
  const saved = mayName ? [...text.matchAll(SAVED_PLACEHOLDER)].map((match) => match[1]!) : [];
  const savedList = saved.join(" ");
  useEffect(() => {
    if (mayName) vault?.want(savedList ? savedList.split(" ") : []);
  }, [mayName, vault, savedList]);
  return mayName && vault?.names ? vault : null;
}

/**
 * Text cut into plain runs and the `$NAME`s drawn as Vault links. A name the viewer's Vault
 * exports opens it. A saved placeholder the viewer can't open says so: another person's always
 * names their own Vault, so a variable of the same name is not the one it means. Any other
 * `$NAME`, such as `$HOME`, stays text.
 */
export function vaultVariableParts(
  text: string,
  names: ReadonlySet<string>,
  fromOtherPerson = false,
): VaultVariablePart[] {
  if (!MAY_NAME_VARIABLE.test(text)) return [text];
  const parts: VaultVariablePart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[2]!;
    const start = match.index + match[1]!.length;
    const end = start + name.length + 1;
    const saved =
      text.slice(start - SAVED_PLACEHOLDER_OPEN.length, start) === SAVED_PLACEHOLDER_OPEN &&
      text[end] === "]";
    const own = names.has(name) && !(saved && fromOtherPerson);
    if (!own && !saved) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push({ name, denied: !own });
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

const VAULT_URL_PREFIX = "rakazo-vault:";
const DENIED_MARK = "#denied";
const VAULT_URL = /^rakazo-vault:([A-Za-z_][A-Za-z0-9_]*)(#denied)?$/;

/** Bot Markdown with each `$NAME` drawn as a Vault link, outside code and links, made a link. */
export function withVaultVariables(markdown: string, names: ReadonlySet<string>): string {
  if (!MAY_NAME_VARIABLE.test(markdown)) return markdown;
  return rewriteOutsideCode(
    markdown,
    (run) =>
      vaultVariableParts(run, names)
        .map((part) =>
          typeof part === "string"
            ? part
            : // Escaped so the name reads as itself, never as math or emphasis.
              `[\\$${part.name.replace(/_/g, "\\_")}](${VAULT_URL_PREFIX}${part.name}${part.denied ? DENIED_MARK : ""})`,
        )
        .join(""),
    new Map(),
    true,
  );
}

/** The Vault variable a link made by `withVaultVariables` names, if this href is one. */
export function markdownVaultVariable(href: string | undefined): VaultVariableLink | undefined {
  const match = href ? VAULT_URL.exec(href) : null;
  return match ? { name: match[1]!, denied: Boolean(match[2]) } : undefined;
}
