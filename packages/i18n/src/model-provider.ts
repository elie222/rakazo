import { i18n } from "@lingui/core";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import {
  connectedBackupOptions as catalogBackupOptions,
  providerDisplayName as catalogDisplayName,
} from "@rakazo/contracts";

function localizedEntry<T extends Pick<ModelCatalogEntry, "subscriptionName">>(entry: T): T {
  return entry.subscriptionName
    ? {
        ...entry,
        subscriptionName: i18n._({ id: entry.subscriptionName, message: entry.subscriptionName }),
      }
    : entry;
}

export function providerDisplayName(
  entry: Parameters<typeof catalogDisplayName>[0],
  auth?: string,
): string {
  return catalogDisplayName(localizedEntry(entry), auth);
}

export function connectedBackupOptions(...args: Parameters<typeof catalogBackupOptions>) {
  const [catalog, ...rest] = args;
  return catalogBackupOptions(catalog.map(localizedEntry), ...rest);
}
