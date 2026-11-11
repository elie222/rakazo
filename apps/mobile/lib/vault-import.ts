import type { VaultCsv } from "@rakazo/contracts";
import { parseVaultCsv, VAULT_IMPORT_FILE_LIMIT } from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

/**
 * A password manager's CSV export picked and read on this device; null when the person cancels.
 * The copy the picker makes is deleted once read, so no passwords are left in the app's cache.
 */
export async function pickVaultCsv(): Promise<VaultCsv | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    // Some file providers label a CSV as a spreadsheet or as plain bytes; the parser decides.
    type: [
      "text/csv",
      "text/comma-separated-values",
      "text/plain",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ],
    copyToCacheDirectory: true,
  });
  const asset = picked.canceled ? undefined : picked.assets?.[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? file.size) > VAULT_IMPORT_FILE_LIMIT) return { error: "too_large" };
    return parseVaultCsv(await file.text());
  } finally {
    try {
      file.delete();
    } catch {
      // Already gone; the cache is the system's to clear.
    }
  }
}
