/**
 * Optional outbound proxy for the browser on bot computers.
 *
 * RAKAZO_COMPUTER_PROXY names an upstream proxy, with or without credentials:
 *   http://user:pass@proxy.example.com:8080
 *   socks5://user:pass@proxy.example.com:1080
 *
 * Chrome cannot send proxy credentials from policy, so each computer runs tinyproxy on
 * loopback. It forwards to the upstream with the credentials, and a managed Chrome policy points
 * the browser at it. The credentials reach the computer only through the prepare command's
 * environment and a root-only config file; they never appear in a command line or a log.
 */

export const COMPUTER_PROXY_ENV = "RAKAZO_COMPUTER_PROXY";
/** Name of the variable that carries the generated tinyproxy config into the prepare command. */
export const COMPUTER_PROXY_CONFIG_ENV = "RAKAZO_COMPUTER_PROXY_CONFIG";
export const COMPUTER_PROXY_PORT = 18_080;

const UPSTREAM_TYPES: Record<string, "http" | "socks5" | "socks4"> = {
  "http:": "http",
  "socks5:": "socks5",
  "socks5h:": "socks5",
  "socks4:": "socks4",
};

export interface ComputerProxy {
  type: "http" | "socks5" | "socks4";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Parses RAKAZO_COMPUTER_PROXY. Unset or blank means no proxy; anything malformed throws. */
export function computerProxyFromEnv(
  env: Record<string, string | undefined> = process.env,
): ComputerProxy | undefined {
  const raw = env[COMPUTER_PROXY_ENV]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${COMPUTER_PROXY_ENV} is not a valid URL`);
  }
  const type = UPSTREAM_TYPES[url.protocol];
  if (!type) {
    throw new Error(`${COMPUTER_PROXY_ENV} must start with http://, socks5:// or socks4://`);
  }
  const port = Number(url.port || (type === "http" ? 80 : 1080));
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${COMPUTER_PROXY_ENV} needs a host and a valid port`);
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  // tinyproxy reads "user:pass@host:port" without decoding, so these characters would split it.
  if (/[\s:@"]/.test(username) || /[\s@"]/.test(password)) {
    throw new Error(
      `${COMPUTER_PROXY_ENV}: the proxy username cannot contain spaces, ':', '@' or '"', and the password cannot contain spaces, '@' or '"'`,
    );
  }
  return {
    type,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    ...(username && { username }),
    ...(password && { password }),
  };
}

/** The tinyproxy config for one computer. Listens on loopback only. */
export function tinyproxyConfig(proxy: ComputerProxy): string {
  const credentials = proxy.username
    ? `${proxy.username}${proxy.password ? `:${proxy.password}` : ""}@`
    : "";
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  return [
    `Port ${COMPUTER_PROXY_PORT}`,
    "Listen 127.0.0.1",
    "Allow 127.0.0.1",
    "Timeout 600",
    "MaxClients 200",
    "DisableViaHeader Yes",
    "LogLevel Warning",
    'LogFile "/var/log/rakazo-proxy/tinyproxy.log"',
    'PidFile "/run/rakazo-proxy/tinyproxy.pid"',
    `Upstream ${proxy.type} ${credentials}${host}:${proxy.port}`,
    "",
  ].join("\n");
}

/** Environment for the prepare command: the config when a proxy is set, nothing otherwise. */
export function computerProxyPrepareEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const proxy = computerProxyFromEnv(env);
  if (!proxy) return {};
  return {
    [COMPUTER_PROXY_CONFIG_ENV]: Buffer.from(tinyproxyConfig(proxy)).toString("base64"),
  };
}

const BROWSER_POLICY_DIRS = [
  "/etc/chromium/policies/managed",
  "/etc/chromium-browser/policies/managed",
  "/etc/opt/chrome/policies/managed",
  "/etc/brave/policies/managed",
];

const PROXY_POLICY = JSON.stringify({
  ProxyMode: "fixed_servers",
  ProxyServer: `http://127.0.0.1:${COMPUTER_PROXY_PORT}`,
  // Loopback stays direct: the bot's own tools reach the browser over its debugging port.
  ProxyBypassList: "<-loopback>;localhost;127.0.0.1;[::1]",
});

/**
 * Shell that starts or stops the loopback proxy and its browser policy. Runs as part of the
 * prepare command, after the desktop packages are installed, and is safe to repeat.
 */
export const PREPARE_COMPUTER_PROXY = [
  'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  // Stops Rakazo's own instance and waits until its port is free, so a restart can bind it.
  "stop_computer_proxy() {",
  "  pid=$(cat /run/rakazo-proxy/tinyproxy.pid 2>/dev/null || true)",
  '  [ -n "$pid" ] || return 0',
  '  $root kill "$pid" 2>/dev/null || true',
  "  for _ in $(seq 1 50); do",
  `    (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_PROXY_PORT}) 2>/dev/null || return 0`,
  "    sleep 0.1",
  "  done",
  '  $root kill -9 "$pid" 2>/dev/null || true',
  "}",
  `if [ -n "\${${COMPUTER_PROXY_CONFIG_ENV}:-}" ]; then`,
  "  if ! command -v tinyproxy >/dev/null; then",
  "    $root apt-get update -qq",
  // policy-rc.d keeps the package from starting its own instance on a public port.
  "    printf '#!/bin/sh\\nexit 101\\n' | $root sh -c 'cat > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d'",
  "    $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tinyproxy",
  "    $root rm -f /usr/sbin/policy-rc.d",
  "  fi",
  "  $root mkdir -p /etc/rakazo-proxy /run/rakazo-proxy /var/log/rakazo-proxy",
  "  $root chmod 700 /etc/rakazo-proxy",
  // tinyproxy drops to its own user, which must write its pid and log.
  "  proxy_user=$(id -u tinyproxy >/dev/null 2>&1 && echo tinyproxy || echo nobody)",
  '  $root chown "$proxy_user" /run/rakazo-proxy /var/log/rakazo-proxy',
  "  new=$(mktemp)",
  `  printf '%s' "$${COMPUTER_PROXY_CONFIG_ENV}" | base64 -d > "$new"`,
  '  printf \'User %s\\nGroup %s\\n\' "$proxy_user" "$(id -gn "$proxy_user")" >> "$new"',
  '  changed=1; $root cmp -s "$new" /etc/rakazo-proxy/tinyproxy.conf && changed=0',
  '  if [ "$changed" -eq 1 ]; then $root install -m 600 "$new" /etc/rakazo-proxy/tinyproxy.conf; fi',
  '  rm -f "$new"',
  "  pid=$(cat /run/rakazo-proxy/tinyproxy.pid 2>/dev/null || true)",
  '  running=0; [ -n "$pid" ] && $root kill -0 "$pid" 2>/dev/null && running=1',
  '  if [ "$running" -eq 1 ] && [ "$changed" -eq 1 ]; then stop_computer_proxy; running=0; fi',
  // Only Rakazo's own instance is ever stopped; policy-rc.d kept the package's from starting.
  '  if [ "$running" -eq 0 ]; then $root tinyproxy -c /etc/rakazo-proxy/tinyproxy.conf; fi',
  "  ready=0",
  "  for _ in $(seq 1 50); do",
  `    if (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_PROXY_PORT}) 2>/dev/null; then ready=1; break; fi`,
  "    sleep 0.1",
  "  done",
  '  if [ "$ready" -ne 1 ]; then echo "the computer proxy did not start" >&2; exit 1; fi',
  `  policy=${shellQuoteForScript(PROXY_POLICY)}`,
  `  for dir in ${BROWSER_POLICY_DIRS.join(" ")}; do`,
  '    [ "$(cat "$dir/rakazo-proxy.json" 2>/dev/null)" = "$policy" ] && continue',
  '    printf \'%s\\n\' "$policy" | $root sh -c \'mkdir -p "$1" && cat > "$1/rakazo-proxy.json"\' sh "$dir" || echo "could not set the proxy policy in $dir" >&2',
  "  done",
  "else",
  // The proxy was turned off: the browser goes direct again.
  `  for dir in ${BROWSER_POLICY_DIRS.join(" ")}; do $root rm -f "$dir/rakazo-proxy.json"; done`,
  "  stop_computer_proxy",
  "  $root rm -f /etc/rakazo-proxy/tinyproxy.conf",
  "fi",
].join("\n");

function shellQuoteForScript(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
