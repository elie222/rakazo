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

The screenshot workflow also uses this login. Both workflows share the
`codex-subscription` concurrency group so refreshes cannot race. Claude runs do not
acquire that shared lock. Both lock users set `queue: max` to retain pending
runs instead of replacing the previous pending entry. Codex refreshes the cache;
the workflow writes it back to the secret even after an update failure. If
authentication is revoked or refresh fails, repeat the login and replace the
secret. No OpenAI API key is used, so requests use the Codex subscription.

Codex runs as a separate unprivileged user without the GitHub write token.
A fresh publishing job applies the patch after rejecting workflow, agent
instruction, and environment-file changes. Only the patch and PR description
are uploaded; authentication and session logs are never artifacts.

## PR screenshot agent

`pr-screenshots.yml` defaults to Codex with the subscription login above. Set the
repository Actions variable `PR_SCREENSHOT_AGENT` to `claude` to switch back;
`codex` selects Codex. Claude uses `CLAUDE_CODE_OAUTH_TOKEN`. The optional
`PR_SCREENSHOT_MODEL` variable overrides the selected agent's model; leave it
unset to use Codex's default or the workflow's Claude default.

Both agents use the same prompt, browser allowlist, output contract and publishing
validation. Codex has shell, local image reading, image generation, web search and
subagents disabled, a read-only filesystem, and an explicit deny on its login
folder. Codex runs as an unprivileged user with a clean environment, separate
from both the runner and browser. Its only sudo permission launches a root-owned,
argument-free wrapper for the isolated browser; it cannot run arbitrary commands
as another user. Browser tools also run with a clean environment. Neither
agent receives the GitHub secret-write token. Failed Codex runs print only a
bounded, credential-filtered set of error lines; private transcripts are deleted.

Runs skip the LLM for non-web changes, obsolete commits, and commits with a
trusted completed-assessment artifact. Otherwise the agent inspects existing PR images and
the current commit's published E2E gallery before capturing missing views. Images
alone do not prove coverage; that decision stays with the model.

Preview deployment and E2E publication each call the shared screenshot workflow.
The first caller exits if the other source is still running; the second starts
the agent. No runner polls or sleeps. Readiness requires the trusted deployment
comment for that exact PR and full commit SHA, plus a trusted E2E completion
artifact retained for 90 days. A different PR's deployment cannot authorize a
capture. Failed or skipped E2E publication still starts the agent, which captures
from the preview; a failed preview deployment never starts it.
Calls for the same PR and commit are serialized through publishing and recheck a trusted
completion artifact. Successful assessments are cached even when E2E images cover
the change and no new capture is needed, so simultaneous events cannot duplicate
the model call. PR description markers never authorize skipping an assessment.
Every requested image must pass publication validation before completion can be
recorded. Retries retain current-commit agent images and append missing views,
so publishing does not remove images used to establish coverage.

Publication skips description updates when the resulting content is unchanged.

Each caller uses the same checked discovery helper and fans out across the
current pull requests found through the source owner and branch, including forks. The queued agent rechecks the PR head before
preparing a browser or restoring a login. Retention deduplicates image URLs and
rejects merged sets beyond the publication limit. The gallery, publisher and
Python reader share the commit-marker template in the testkit.

Publication serializes across commits of each PR and rechecks the head after
uploads. Every matching PR receives the immutable E2E run gallery link; the
primary PR retains the existing stable gallery. No-op updates preserve author
line endings, including descriptions saved in the GitHub web editor.
