import { configuredProtectedBrowser, EncryptedSecretStore } from "@rakazo/adapters";

export async function organizationLoginBrowser(encryptionKey: string) {
  const launch = await configuredProtectedBrowser();
  if (launch) return { launch, encryption: new EncryptedSecretStore(encryptionKey) };
}
