/** The proxy settings Node reads before any service code runs. */
export const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"];

/**
 * Node decides whether fetch follows the proxy, and reads the proxy URLs, before a service can
 * load `.env`, so a proxy configured there is copied into the environment the services start with.
 * The shell's own value wins, and `HTTP_PROXY` and `http_proxy` are both read.
 */
export function applyProxyEnv(env, fileEnv) {
  for (const name of PROXY_ENV) {
    if (env[name]) continue;
    const value = fileEnv[name] ?? fileEnv[name.toLowerCase()];
    if (value) env[name] = value;
  }
  return env;
}
