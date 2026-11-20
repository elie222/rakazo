import { i18n } from "@lingui/core";
import type { ModelCatalogEntry } from "@rakazo/contracts";

export function localizeModelEntry<
  T extends Pick<ModelCatalogEntry, "provider" | "subscriptionName">,
>(entry: T): T {
  return entry.subscriptionName
    ? {
        ...entry,
        subscriptionName: i18n._({ id: entry.subscriptionName, message: entry.subscriptionName }),
      }
    : entry;
}
