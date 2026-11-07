import type { AgentImportNeed, AgentImportSetupItem, MessageBlock } from "@rakazo/contracts";
import { t } from "./i18n";

export type ImportSetupBlock = Extract<MessageBlock, { kind: "import_setup" }>;

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
