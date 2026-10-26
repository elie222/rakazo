# Weekly dependency updates

`weekly-dependencies.yml` runs the Codex CLI on a GitHub-hosted Ubuntu runner
every Tuesday and supports manual dispatch from `main`. The prompt in
`prompts/weekly-dependencies.md` owns the investigation, updates, and validation.
An existing weekly update PR pauses new batches. PRs require review and merge.

Configure two repository Actions secrets before the first run:

- `CODEX_SUBSCRIPTION_AUTH`: refreshable Codex ChatGPT login (`auth.json`).
- `GH_DEPENDENCY_UPDATES_PAT`: a fine-grained GitHub personal access token limited
  to this repository, with **Contents**, **Pull requests**, and **Secrets** write
  permissions. It persists refreshed login credentials and publishes PRs whose
  checks start automatically.

Create a separate file-backed Codex login for this workflow using a temporary
`CODEX_HOME`, then upload it without printing credentials:

```sh
updater_home=$(mktemp -d)
CODEX_HOME="$updater_home" codex -c 'cli_auth_credentials_store="file"' login --device-auth
gh secret set CODEX_SUBSCRIPTION_AUTH < "$updater_home/auth.json"
rm -rf "$updater_home"
gh secret set GH_DEPENDENCY_UPDATES_PAT
```

Use that login only for this serialized workflow. Codex refreshes the cache;
the workflow writes it back to the secret even after an update failure. If
authentication is revoked or refresh fails, repeat the login and replace the
secret. No OpenAI API key is used, so requests use the Codex subscription.

Codex runs as a separate unprivileged user without the GitHub write token.
A fresh publishing job applies the patch after rejecting workflow, agent
instruction, and environment-file changes. Only the patch and PR description
are uploaded; authentication and session logs are never artifacts.
