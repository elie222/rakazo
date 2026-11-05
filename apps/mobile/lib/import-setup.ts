import type {
  AgentImportNeed,
  AgentImportSetupItem,
  AgentImportSetupState,
  MessageBlock,
  RpcInput,
} from "@rakazo/contracts";
import { t } from "./i18n";

export type ImportSetupBlock = Extract<MessageBlock, { kind: "import_setup" }>;

/**
 * Needs Rakazo cannot check from its own data: what a skill declares, and a program or local
 * paths a stdio server relies on. Such rows are never shown as done.
 */
export function isImportSetupVerifiable(item: AgentImportSetupItem): boolean {
  if (item.kind === "skill") return false;
  if (item.kind !== "mcp") return true;
  return !item.needs.some((need) => need.kind === "program" || need.kind === "local_paths");
}

/** Null when it cannot be checked or is not read yet. */
export function isImportSetupDone(
  item: AgentImportSetupItem,
  state: AgentImportSetupState | null,
): boolean | null {
  if (!state || !isImportSetupVerifiable(item)) return null;
  if (item.kind === "model") return state.providers[item.provider] === true;
  if (item.kind === "mcp") return state.serverIds[item.serverId] === true;
  if (item.kind === "routine") return state.routineIds[item.routineId] === true;
  return null;
}

/** Rows that cannot be checked keep the full list. */
export function isImportSetupComplete(
  block: ImportSetupBlock,
  state: AgentImportSetupState | null,
): boolean {
  return Boolean(state) && block.items.every((item) => isImportSetupDone(item, state) === true);
}

/** What to ask the server about: each checkable item, by kind. */
export function importSetupStateInput(
  botId: string,
  block: ImportSetupBlock,
): RpcInput<"bots/importSetupState"> {
  const providers: string[] = [];
  const serverIds: string[] = [];
  const routineIds: string[] = [];
  for (const item of block.items) {
    if (item.kind === "model") providers.push(item.provider);
    else if (item.kind === "mcp") serverIds.push(item.serverId);
    else if (item.kind === "routine") routineIds.push(item.routineId);
  }
  return { botId, providers, serverIds, routineIds };
}

/** A short label for what an item needs, matching the web checklist. */
export function importNeedText(need: AgentImportNeed): string {
  switch (need.kind) {
    case "api_key":
      return t("API key for {provider}", { provider: need.provider });
    case "credentials":
      return t("Credentials: {names}", { names: need.names.join(", ") });
    case "env":
      return t("Environment variables: {names}", { names: need.names.join(", ") });
    case "program":
      return t("Program: {name}", { name: need.name });
    case "local_paths":
      return t("Uses paths on your computer");
    case "requires":
      return t("Needs: {names}", { names: need.names.join(", ") });
    case "turn_on":
      return t("Paused");
    case "bundled_files":
      return t("Uses files that are not imported");
  }
}

/** The row's second line: what it still needs. */
export function importSetupDetail(item: AgentImportSetupItem): string {
  if (item.kind === "model")
    return importNeedText({ kind: "api_key", provider: item.providerName ?? item.provider });
  if (item.kind === "routine") return importNeedText({ kind: "turn_on" });
  return item.needs.map(importNeedText).join(", ");
}
