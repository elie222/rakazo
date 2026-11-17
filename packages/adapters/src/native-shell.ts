/**
 * Install rakazo-net from the command's tunnel settings, then run the command.
 * Unix reads RAKAZO_NET_HELPER. Windows reads the file at RAKAZO_NET_FILE, because the helper
 * does not fit in a Windows process environment. RAKAZO_NET_HOME is the computer's home when
 * the host has one, otherwise $HOME or $env:USERPROFILE.
 */
const UNIX_TAILNET_INSTALL = [
  'if [ -n "$RAKAZO_NET_HELPER" ]; then',
  '  root="$RAKAZO_NET_HOME"',
  '  if [ -z "$root" ]; then root="$HOME"; fi',
  '  bin="$root/.cache/rakazo/net/$RAKAZO_NET_VERSION"',
  '  if [ ! -x "$bin/rakazo-net" ]; then',
  '    part="$bin/rakazo-net.$$"',
  '    { mkdir -p "$bin" && { printf %s "$RAKAZO_NET_HELPER" | base64 -d >"$part" 2>/dev/null || printf %s "$RAKAZO_NET_HELPER" | base64 -D >"$part"; } && chmod 755 "$part" && mv -f "$part" "$bin/rakazo-net"; } || { rm -f "$part"; echo "rakazo-net could not be installed" >&2; }',
  "  fi",
  "  unset RAKAZO_NET_HELPER RAKAZO_NET_VERSION RAKAZO_NET_HOME",
  '  PATH="$bin:$PATH"',
  "  export PATH",
  "fi",
].join("\n");

const WINDOWS_TAILNET_INSTALL = [
  "if ($env:RAKAZO_NET_FILE) {",
  "  $root = if ($env:RAKAZO_NET_HOME) { $env:RAKAZO_NET_HOME } else { $env:USERPROFILE }",
  '  $bin = Join-Path $root ".cache\\rakazo\\net\\$env:RAKAZO_NET_VERSION"',
  '  $script = Join-Path $bin "rakazo-net.py"',
  '  $cmd = Join-Path $bin "rakazo-net.cmd"',
  '  $part = "$cmd.$PID"',
  "  New-Item -ItemType Directory -Force -Path $bin | Out-Null",
  "  if (-not (Test-Path -LiteralPath $script)) {",
  "    try {",
  "      Copy-Item -LiteralPath $env:RAKAZO_NET_FILE -Destination $script -Force",
  "      Set-Content -LiteralPath $part -Encoding ascii -Value @(",
  "        '@echo off',",
  '        \'where python >nul 2>&1 && python "%~dp0rakazo-net.py" %* || python3 "%~dp0rakazo-net.py" %*\'',
  "      )",
  "      Move-Item -LiteralPath $part -Destination $cmd -Force",
  "    } catch {",
  "      Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue",
  '      Write-Error "rakazo-net could not be installed"',
  "    }",
  "  }",
  '  $env:Path = "$bin;" + $env:Path',
  "  Remove-Item Env:RAKAZO_NET_FILE, Env:RAKAZO_NET_VERSION, Env:RAKAZO_NET_HOME -ErrorAction SilentlyContinue",
  "}",
].join("\n");

/** The command a native shell runs, installing rakazo-net first when the settings are present. */
export function nativeTailnetCommand(command: string, platform: string): string {
  const install = platform === "win32" ? WINDOWS_TAILNET_INSTALL : UNIX_TAILNET_INSTALL;
  return `${install}\n${command}`;
}

/** Interpreter arguments for commands on a native host, independent of the backend's OS. */
export function nativeShellCommandArgv(
  command: string,
  environment: { platform: string; shell: string },
): string[] {
  return environment.platform === "win32"
    ? [environment.shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : [environment.shell, "-lc", command];
}
