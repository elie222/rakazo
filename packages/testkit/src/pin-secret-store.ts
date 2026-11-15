export function pinLocalSecretStore(source: NodeJS.ProcessEnv = process.env): void {
  source.SECRET_STORE = "encrypted";
  for (const name of Object.keys(source)) {
    if (name.startsWith("INFISICAL_")) delete source[name];
  }
}
