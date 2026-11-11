/**
 * The integration and E2E harness loads the developer's root .env before
 * anything is pinned, so a configured remote secret store would receive every
 * secret the tests write. Pin the store to the local encrypted one instead.
 */
export function pinLocalSecretStore(source: NodeJS.ProcessEnv = process.env): void {
  source.SECRET_STORE = "encrypted";
  for (const name of Object.keys(source)) {
    if (name.startsWith("INFISICAL_")) delete source[name];
  }
}
