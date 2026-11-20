# Deploying this fork's server to a desktop install

The Mac mini runs the official Rakazo desktop app with its `rakazo-server` bundle swapped for one
built from this fork's `main`. Three workflows keep it current:

- `upstream sync` merges upstream's `main` into this fork's `main` every morning.
- `ci` runs the tests on every push to `main`, then publishes a compatible mobile update.
- `desktop server deploy` builds the bundle on a GitHub Apple silicon runner once those tests pass,
  copies it to the mini over Tailscale, and runs `scripts/fork/deploy-desktop-server.sh` there. That
  script stops Rakazo, swaps the bundle in, reopens the app, and waits for the API's health check.
  If the new server does not come up, it puts the previous bundle back. It refuses a bundle older
  than the installed app, since that server would run against migrations it has never seen.

When upstream's changes conflict with the fork's, the sync run fails. Merge `upstream/main` into a
branch, resolve the conflicts, and merge its PR with **Create a merge commit**. A squash leaves the
merge base behind, so every later sync conflicts again.

When the desktop app updates itself, it starts that release's official server. Run
`gh workflow run "desktop server deploy"` to put the fork's back without waiting for the next merge.

## One-time setup

Repository secrets (Settings > Secrets and variables > Actions):

- `EXPO_TOKEN`: an Expo access token for the mobile update.
- `SYNC_TOKEN`: a fine-grained GitHub token for this repository only, with Contents and Workflows
  read and write. Pushes made with the built-in token start no workflows and cannot change workflow
  files.

The deploy joins the tailnet through workload identity federation, so no tailnet secret is stored.
A shell on the mini is worth more than anything else here, so the trust is narrow:

1. Add the tag and its access to the tailnet policy. The tag is the deploy's alone, so other CI
   on the tailnet never reaches the mini:

   ```json
   "tagOwners": { "tag:rakazo-deploy": ["autogroup:admin"] },
   "grants": [{ "src": ["tag:rakazo-deploy"], "dst": ["tag:server"], "ip": ["22"] }],
   "ssh": [{ "action": "accept", "src": ["tag:rakazo-deploy"], "dst": ["tag:server"], "users": ["<user>"] }]
   ```

   Replace `<user>` with the mini's login user, the same value as `DEPLOY_SSH_USER` below. Left
   as is, the mini's Tailscale SSH refuses the deploy with "tailnet policy does not permit you to
   SSH as user".

2. Under Trust credentials, add an OpenID Connect credential: issuer GitHub Actions, subject
   `<prefix>:environment:desktop-deploy`, scope Auth Keys write, tag `tag:rakazo-deploy`. The
   prefix is `sub_claim_prefix` from `gh api repos/<owner>/rakazo/actions/oidc/customization/sub`;
   with immutable subjects it carries the account and repository IDs, so the plain
   `repo:<owner>/rakazo` form is refused. Only jobs in the `desktop-deploy` environment carry that
   subject, and only `main` may use the environment.

3. Secrets of the `desktop-deploy` environment: `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` from that
   credential (not sensitive, but kept beside the rest), `DEPLOY_SSH_HOST` (the mini's tailnet
   name), and `DEPLOY_SSH_USER`.

## Settings the fixes read (`stack/.env`)

- `RAKAZO_CLAUDE_CODE_COMMAND`: path to `claude`, since the desktop server's PATH has only the
  system directories.
- `RAKAZO_CLAUDE_CODE_MODELS`: extra Claude Code model ids to offer beside `PI_DEFAULT_MODEL`.
- `RAKAZO_EXTRA_AUTH_ORIGINS`: also accepted as MCP sign-in callback origins.
- `RAKAZO_TOOL_ACTIVATION=direct`: lets loaded tools be called by name (from PR #1).
