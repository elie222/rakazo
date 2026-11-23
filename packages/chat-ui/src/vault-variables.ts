import type { BotSecretMetadata } from "@rakazo/contracts";
import { commandVariableName } from "@rakazo/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SplitSource } from "./markdown";
import { rewriteOutsideCode, splitSource } from "./markdown";

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

/**
 * The chat's Vault variables once they are read, asked for when this text could name one. Another
 * person's saved placeholders never open the viewer's Vault, so they ask for no read again.
 */
export function useVaultVariables(text: string, fromOtherPerson = false): VaultVariables | null {
  const vault = useContext(VaultVariablesContext);
  const mayName = vault !== null && MAY_NAME_VARIABLE.test(text);
  const saved =
    mayName && !fromOtherPerson
      ? [...text.matchAll(SAVED_PLACEHOLDER)].map((match) => match[1]!)
      : [];
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

/** Bot Markdown with each `$NAME` drawn as a Vault link, outside code, links and HTML, made a link. */
export function withVaultVariables(markdown: string, names: ReadonlySet<string>): string {
  // Most text names none of the viewer's variables, so it is never parsed.
  if (vaultVariableParts(markdown, names).every((part) => typeof part === "string")) {
    return markdown;
  }
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

/**
 * `withVaultVariables` for a reply that may still be streaming: once split, only the blocks new
 * text can change are rewritten again, so each chunk costs the same however long the reply is.
 */
export function useVaultVariableMarkdown(
  markdown: string,
  names: ReadonlySet<string> | undefined,
  streaming: boolean,
): string {
  // As the web reply does, a streamed reply stays split once it finishes.
  const [split, setSplit] = useState(streaming);
  if (streaming && !split) setSplit(true);
  const previousSplit = useRef<SplitSource | undefined>(undefined);
  const linked = useRef<{ names: ReadonlySet<string>; blocks: Map<string, string> } | undefined>(
    undefined,
  );
  return useMemo(() => {
    if (!names) return markdown;
    if (!split) return withVaultVariables(markdown, names);
    previousSplit.current = splitSource(markdown, previousSplit.current);
    const previous = linked.current?.names === names ? linked.current.blocks : undefined;
    const blocks = new Map<string, string>();
    const result = previousSplit.current.blocks
      .map(({ source }) => {
        const block = previous?.get(source) ?? withVaultVariables(source, names);
        blocks.set(source, block);
        return block;
      })
      .join("");
    linked.current = { names, blocks };
    return result;
  }, [markdown, names, split]);
}

/** One Vault the app read, and what opening an item there needs. */
export type VaultRead<Where> = { items: readonly BotSecretMetadata[]; where: Where };

/**
 * What both apps make of their Vault reads: the command variables they export, and `want`, which
 * asks for the reads and reads again for a saved placeholder they lack. `reads` is undefined until
 * every Vault is read; a later one holds a name an earlier one also exports, as a Space's own Vault
 * does over the account's. `readsOf` names what was read, such as the Space, so a name checked in
 * one is checked again in another. `readAgain` reads every Vault again and says whether it worked;
 * a name is checked only once it did, and one that failed is tried again on the next `want`.
 */
export function useVaultVariableReads<Where>({
  reads,
  readsOf,
  setWanted,
  readAgain,
}: {
  reads: readonly VaultRead<Where>[] | undefined;
  readsOf: string;
  setWanted: (wanted: true) => void;
  readAgain: () => Promise<boolean>;
}) {
  const byName = useMemo(() => {
    if (!reads) return undefined;
    const found = new Map<string, { item: string; where: Where }>();
    for (const { items, where } of reads)
      for (const item of items)
        if (item.auth?.type === "command")
          found.set(commandVariableName(item.name), { item: item.name, where });
    return found;
  }, [reads]);
  const checked = useRef(new Set<string>());
  const reading = useRef(new Set<string>());
  const want = useCallback(
    (saved: readonly string[]) => {
      setWanted(true);
      if (!byName) return;
      const unread = saved
        .filter((name) => !byName.has(name))
        .map((name) => `${readsOf}\n${name}`)
        .filter((key) => !checked.current.has(key) && !reading.current.has(key));
      if (unread.length === 0) return;
      for (const key of unread) reading.current.add(key);
      void readAgain().then((read) => {
        for (const key of unread) {
          reading.current.delete(key);
          if (read) checked.current.add(key);
        }
      });
    },
    [byName, readsOf, setWanted, readAgain],
  );
  const names = useMemo(() => byName && new Set(byName.keys()), [byName]);
  const find = useCallback((name: string) => byName?.get(name), [byName]);
  return { want, names, find };
}
