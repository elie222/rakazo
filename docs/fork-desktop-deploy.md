# Deploying this fork's server to a desktop install

The Mac mini runs the official Rakazo desktop app with its `rakazo-server` bundle swapped for one
built from this fork. The fixes live on `feat/desktop-claude-code-fixes`; each release gets a
`desktop/v<version>` branch that merges them onto the release tag.

## After an upstream release

1. Make the release branch (on any machine) and push it:

   ```bash
   git fetch upstream --tags
   git switch -c desktop/v0.14.0 v0.14.0
   git merge feat/desktop-claude-code-fixes
   git push -u origin desktop/v0.14.0
   ```

2. Build the bundle on the mini, so native modules are darwin-arm64. Stop if `df -g /` shows less
   than 12 GB free.

   ```bash
   git clone --depth 1 --branch desktop/v0.14.0 https://github.com/mchisolm0/rakazo.git ~/oss/rakazo-build
   cd ~/oss/rakazo-build
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile \
     --filter rakazo --filter "@rakazo/api..." --filter "@rakazo/worker..." --filter "@rakazo/web..."
   DATABASE_URL=postgres://rakazo:rakazo@127.0.0.1:5433/rakazo pnpm db:generate
   pnpm --filter @rakazo/web build
   node scripts/build-server-bundle.mjs out
   ```

3. Let the app update itself, open it once so it installs `runtime/server-0.14.0`, and check it is
   healthy.

4. Quit Rakazo. `osascript -e 'quit app "Rakazo"'` does nothing over ssh, so send `kill -TERM` to
   the main `Rakazo.app/Contents/MacOS/Rakazo` process, then to any `rakazo-server/apps/` processes
   it leaves behind.

5. Swap the bundle, keeping the `.complete` marker, and reopen:

   ```bash
   R=~/Library/Application\ Support/Rakazo/stack/runtime/server-0.14.0
   mv "$R/rakazo-server" ~/oss/rakazo-build/official-rakazo-server
   tar -C "$R" -xJf ~/oss/rakazo-build/out/rakazo-server-darwin-arm64-0.14.0.tar.xz
   open -a Rakazo
   ```

6. Check that `stack/logs/api.log` says "api listening", `worker.log` says "worker ready", and
   neither logs errors. If it does not come up, move `official-rakazo-server` back.

7. Clean up: remove `~/oss/rakazo-build` and the previous `runtime/server-*` folder, then run
   `pnpm store prune`.

## Settings the fixes read (`stack/.env`)

- `RAKAZO_CLAUDE_CODE_COMMAND`: path to `claude`, since the desktop server's PATH has only the
  system directories.
- `RAKAZO_CLAUDE_CODE_MODELS`: extra Claude Code model ids to offer beside `PI_DEFAULT_MODEL`.
- `RAKAZO_EXTRA_AUTH_ORIGINS`: also accepted as MCP sign-in callback origins.
- `RAKAZO_TOOL_ACTIVATION=direct`: lets loaded tools be called by name (from PR #1).
