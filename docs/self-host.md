# Self-hosting Rakazo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Boat). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, `pnpm sandbox:build`, `pnpm dev`, then the URL it prints ([http://127.0.0.1:5173](http://127.0.0.1:5173) by default, or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `novita`, `daytona`, `createos`, or `boat` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.
A provider that authenticates from the host needs no key: for Amazon Bedrock with an ECS task,
IRSA or EC2 instance role, opt in with `PI_DEFAULT_CREDENTIALS=host` and set
`PI_DEFAULT_PROVIDER=amazon-bedrock`, `PI_DEFAULT_MODEL` and `AWS_REGION`. With an instance
role, keep [restricted computer egress](#restricted-computer-egress) on so bot computers
cannot read the role's credentials from the metadata endpoint.
Approvals have three modes in **Settings → Approvals**: Never ask runs every action, Auto lets an
approval model pass actions that fit the request, and Ask asks before any change. A space starts
in Auto, which asks like Ask until an approval model is available. Each
person can allow or block single tools and sites in every mode, and a space can customize its
approvals apart from the account.

In **Settings → Models → Approval model**, each user can select a model
from an existing connection and add ordered backups, independently of their main model. Personal
connections use their own credentials; hosted calls follow the same Rakazo credit rules as chat.
Backups are tried only when a checker fails. An explicit ask, including an uncertain decision,
still requires a person.

The deployment checker remains the default when no approval model is selected. For OpenRouter
Jev, set `RAKAZO_AUTO_REVIEW_PROVIDER=openrouter` and
`RAKAZO_AUTO_REVIEW_MODEL=typesafe/jev-1.14`; it uses `OPENROUTER_API_KEY` and the Decisions API.
TypeSafe direct remains available through `RAKAZO_AUTO_REVIEW_PROVIDER=jev` and
`TYPESAFE_API_KEY`. Core runs without either hosted service.

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Signup never grants server-administration permissions. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`).

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

### Bot computer resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `RAKAZO_COMPUTER_MEMORY` | `2g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS` | `2` | Whole or fractional cores, e.g. `1.5` |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

### API and worker memory

Chat runs execute in the API container that receives the message, and routines and other
background runs execute in the worker, so both hold live agent turns. In the production Compose
file, `RAKAZO_API_MEMORY_LIMIT` and `RAKAZO_WORKER_MEMORY_LIMIT` cap them (Compose sizes such as
`2g` or `3072m`, default `2g` each). Raise them on a larger host. Deploys briefly run the old and
new container of each side by side, so leave room for both.

### Restricted computer egress

Restricted egress gives Docker computers the public internet (browsing, DNS, apt, git
over SSH) but not the Docker host, the LAN, or link-local cloud metadata such as
`169.254.169.254`, which on a cloud VM would hand instance credentials to anything a bot runs.

It takes two parts:

1. `SANDBOX_COMPUTER_EGRESS=restricted` gives each computer network a deterministic host
   bridge name (`rakazo-c…`) instead of a generic `br-*`.
2. The host ruleset, applied once per Docker host:

   ```bash
   sudo bash infra/compose/restrict-computer-egress.sh
   ```

   `install-images.sh` downloads and runs it (asking for sudo) and records the result in
   `.env`. Where the rules cannot be installed (macOS, Windows, Docker Desktop, rootless
   Docker, no iptables, or a failed run) it writes `SANDBOX_COMPUTER_EGRESS=open` and says
   why. The script drops forwarded traffic from `rakazo-c*` bridges to all non-public IPv4/IPv6
   destinations via the `DOCKER-USER` chain, adds an `INPUT` drop so computers cannot open
   connections to the host (established replies to host-initiated control and screen
   connections still flow), and installs a systemd oneshot so the rules return after a
   reboot. `--print` shows the exact rules without changing anything; `--remove` uninstalls.

Before the first restricted computer starts, the supervisor checks that the host drops
connections from a `rakazo-c*` bridge. Without the ruleset, computers fail to start with an
error naming the script instead of running unrestricted; run the script (no restart needed)
or set `SANDBOX_COMPUTER_EGRESS=open` and recreate the supervisor.

When `SANDBOX_COMPUTER_EGRESS` is unset, the Compose files use `auto`: the supervisor runs the
same check and uses restricted egress if the ruleset is in place, otherwise open egress with a
warning in its log. It keeps the first completed answer; a check that could not finish (a Docker
error or timeout) fails that computer's start and runs again on the next one. An install from before the ruleset existed therefore
keeps working when it upgrades. After installing the ruleset, recreate the supervisor, or set
`restricted` to refuse computers whenever the rules are missing. A host-run supervisor
(`pnpm dev`) and the desktop app's **This computer** stack default to open: Docker Desktop
keeps its bridges in a VM the host rules cannot reach.

Screen streaming is unaffected: the supervisor and web proxy join each computer's bridge,
and the ruleset exempts traffic whose in- and out-interface are both `rakazo-c*` before
any drop (that exemption is load-bearing on hosts where `br_netfilter` feeds bridged
frames through `FORWARD`). Rules match interface names rather than subnets, so computer
create/delete cycles need no firewall maintenance; deleting a computer removes its
traffic from the match and nothing else. A computer provisioned while egress was open
is replaced on its next provision — resuming it on an unnamed bridge would bypass the
restriction.

Computers resolve names through Docker's embedded DNS, which forwards each lookup to the
host's resolvers from inside the computer's network. When the host's resolver has a private
address, as a cloud VPC resolver or a LAN router does, the ruleset drops that forward too and
every lookup times out while connections by IP still work. Set `SANDBOX_COMPUTER_DNS` to
public resolvers (comma-separated IP addresses, such as `1.1.1.1,1.0.0.1`) and recreate the
supervisor: Docker then forwards computers' lookups there, and each computer picks the
servers up on its next provision.

If computers must reach LAN services, an internal proxy, or endpoints bound to the host,
set `SANDBOX_COMPUTER_EGRESS=open`, recreate the supervisor, and run
`sudo bash infra/compose/restrict-computer-egress.sh --remove`. The flag alone does not
uninstall the host rules, which keep matching the still-named `rakazo-c*` bridges until
removed.

The ruleset requires Linux Docker Engine with the iptables backend; Docker Desktop, rootless
Docker, and `firewall-backend: nftables` are unsupported. The
`SANDBOX_SCREEN_NETWORK=internal` topology shares one network instead of per-bot bridges,
so the mode does not apply there.

Where Docker Engine runs in a Linux VM, as with OrbStack on macOS, the rules belong in the VM,
which `sudo` on the host cannot reach. Apply them from a container on the VM's host network
instead, and keep it running: the VM does not persist the rules, so a loop puts them back after
a restart. The installer does not download the script on macOS. From the directory that holds
the stack's `.env`:

```bash
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/restrict-computer-egress.sh
```

Save the following as `egress.yml` beside that script and start it with
`docker compose -f egress.yml up -d`. The name keeps it in its own Compose project:

```yaml
name: rakazo-computer-egress
services:
  computer-egress:
    image: alpine:3
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped
    volumes:
      - ./restrict-computer-egress.sh:/restrict-computer-egress.sh:ro
    command: >-
      sh -c "apk add --no-cache bash iptables ip6tables &&
      while true; do bash /restrict-computer-egress.sh --apply; sleep 60; done"
```

Then change `SANDBOX_COMPUTER_EGRESS` from `open` to `restricted` in `.env` and recreate the
supervisor. Docker Desktop has not been tested this way.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (`openssl rand -hex 16` each), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). Signup never grants server-administration permissions.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host), matching the images
compose. Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing database volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

### Database roles

Rakazo uses two Postgres logins:

- The owner (`POSTGRES_USER`, or `DATABASE_MIGRATION_URL` outside Compose) runs migrations and
  owns the tables.
- The app login (`rakazo_app` with `POSTGRES_APP_PASSWORD`, or `DATABASE_URL`) is not a
  superuser, cannot bypass row-level security, cannot create objects, and can only read and write
  the app tables.

`pnpm db:migrate` (in containers, its prebuilt form `pnpm --filter @rakazo/api db:deploy`, which the
one-shot `migrate` container runs before the API starts) applies the migrations and the job queue
schema as the owner. Only that container gets the owner login, so code running in the API or
worker cannot find one that bypasses row-level security. It then creates the app login named in `DATABASE_URL`, or updates its
password, and grants it the `rakazo_app` role. When migrations run as a role without
`CREATEROLE`, as on some managed Postgres, create the login yourself and
`GRANT rakazo_app TO <login>`.

Messages, events, threads, memory, artifacts, secrets, model and voice credentials, skills, bots,
runs, tasks, routines, connections, MCP servers and sign-ins, computers, boards and tickets,
messaging identities and outbox, external conversations, steering messages, usage, scratchpad
items and approval rules have row-level security. Each signed-in request sees only its Space's
rows, plus the user's own account-level credentials. A query that leaves out its Space filter
returns nothing from other Spaces. A background job that acts for one run, routine, computer,
skill, thread or cloud agent runs as that row's Space and user, so agent tools get the same
backstop. Security events are written and read only in system scope. Reconcilers, queue sweeps,
the messaging outbox drain and webhooks run in a named system scope (`runAsSystem` in
`packages/db`). The job queue's tables (`graphile_worker`) hold job metadata, not Space content:
graphile-worker turns on row-level security for them, and `pnpm db:migrate` adds a policy that
gives the app login every row.

With only `DATABASE_URL` set, migrations and the app share one login. Everything keeps working,
but `pnpm db:migrate`, the API and the worker warn that row-level security is not enforced. To fix
this, set `DATABASE_MIGRATION_URL` to the owner and `DATABASE_URL` to a new login.

Run `pg_dump` as the owner. The app login would only dump rows it is allowed to see.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. `SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` come from the operator's environment on every start. An empty allowlist clears any old stored list; signup order never grants privileges.

With a nonempty signup allowlist and SMTP configured, users—including existing accounts—must
verify their email to sign in. Without an allowlist, verification never blocks: a password signup
signs in at once and is sent a verification link that only marks the address verified.

SMTP also enables sign-in with a six-digit emailed code, which expires after ten minutes and allows
three attempts. A code can create an account, so it follows the same registration and allowlist
rules as password signup. Signing in with a code to an existing unverified account removes that
account's password, SSO links and sessions, since nothing proved they belonged to the mailbox
owner. This is what stops someone who registered another person's address from keeping access.

Allowlisted signup requires mailbox verification and email delivery, including the first account.
Without email delivery, use the server-side account bootstrap described below; public signup never marks an address verified or assigns server permissions.

Server configuration belongs in the operator's environment. App accounts cannot change signup policy,
server integration credentials, or deployment updates, and cannot read deployment security logs.
`SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` are authoritative on every start; an empty allowlist clears any old stored policy.
There is no app-admin role, first-user privilege, or `ADMINS` list. Workspace owners manage only their own workspace.

For an installation without email, first set `SIGNUPS_ENABLED=false` in `.env` and start the stack.
Create the intended account privately (the password stays in the shell environment):

```bash
read -r -p "Account email: " OWNER_EMAIL
read -r -s -p "Account password (at least 16 characters): " OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
docker compose --env-file .env -f docker-compose.images.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
unset OWNER_EMAIL OWNER_PASSWORD
```

For a source checkout, use `-f infra/compose/docker-compose.yml` instead. This creates an ordinary verified account and a personal workspace, with no server privileges. For an existing unverified account, its password must match before it can be verified; an existing verified account is left unchanged.
Keep an installation without email on a trusted local network.

### Optional OpenID Connect SSO

SSO works with a self-hosted or hosted OpenID Connect provider. Leave its settings unset to
keep password authentication alone. Configure all three credentials together on the API:

```env
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_NAME=SSO
OIDC_SCOPES=openid email profile
AUTH_PASSWORD_ENABLED=true
OIDC_ALLOW_SIGNUP_BYPASS=false
```

The issuer must be HTTPS and exactly match the discovery document's issuer. Rakazo loads
`<issuer>/.well-known/openid-configuration`, verifies ID tokens against discovery JWKS with
issuer, audience and nonce checks, and uses authorization codes with PKCE. Additional scopes
may be space- or comma-separated; `openid email profile` are always requested. `OIDC_NAME`
is the button label, defaulting to “SSO”. Secrets remain on the API; Compose clears the worker's
OIDC credentials. The capabilities endpoint exposes only the label, discovery availability,
and enabled authentication methods.

Register this redirect URI at the provider (using your public `BETTER_AUTH_URL` origin):

```text
https://app.example.com/api/auth/callback/oidc
```

Web, Electron and mobile use the same provider redirect URI. Electron completes SSO in a
sandboxed in-app popup sharing the app's session, then returns to the main window. Mobile completes the callback
on the API, then returns to `rakazo://sign-in` (or `rakazo://account` for linking and reauthentication) through Better Auth's Expo authorization proxy
and a native auth browser session. The `rakazo` app scheme is trusted by the auth server;
never register a client secret in the mobile app. Mobile stores the resulting session with
SecureStore, like password sign-in. Native builds need the Expo WebBrowser module.

Provider emails are verified only when `email_verified` is the boolean `true`. False or missing
claims stay unverified, including on subsequent sign-ins. Sign-in never links accounts by email.
If an email belongs to another account, sign in to that existing account and choose **Link SSO**
in account settings. Linking requires an authenticated session, a verified provider email and
matching email addresses. The issuer and provider subject identify the linked account thereafter. Changing issuers does
not reuse an old identity. Old-issuer links remain stored but do not count as linked to the
current provider, so **Link SSO** becomes available again. Link the new identity from the
existing signed-in account; authenticated-session, verified-email and matching-email checks
still apply. Restoring the old issuer makes its existing links usable again.

Ordinary SSO sign-in and linking may reuse the identity provider's existing session. They
do not grant fresh authentication proof for account deletion. The account settings' explicit
reauthentication flow requests `prompt=login` and `max_age=0`, binds the callback to the
same linked issuer and subject, and requires the initiating session to remain valid. Only
that callback grants proof to the resulting session, expiring five minutes after provider
authentication (callback delays do not extend it). Its verified
ID token must contain an `auth_time` consistent with that request (allowing 60 seconds of
clock skew) and less than five minutes old. Missing, stale or invalid claims fail closed.
OAuth callbacks are single-use, including concurrent requests. Password verification and
emailed deletion codes remain available. Submit deletion codes through the account settings
or the CSRF-protected `POST /api/auth/delete-user` endpoint; the GET deletion callback is disabled.

SSO signup follows closed registration and the deployment allowlist before creating an account.
Allowlisted provider emails must be verified; signup never bypasses mailbox proof. `OIDC_ALLOW_SIGNUP_BYPASS=true` explicitly admits IdP identities
without applying the allowlist or its email-verification admission requirement. Enable it only
when the IdP controls who may join this deployment. It does **not** reopen closed registration,
and does not change email verification claims or linking rules. Existing admitted accounts can
sign in while registration is closed.

Set `AUTH_PASSWORD_ENABLED=false` for SSO-only operation. Password sign-in, signup, password
reset and password mutation endpoints are disabled server-side, and sign-in forms are hidden.
The API refuses to start in this mode unless all OIDC credentials are configured. It can still
start while discovery is temporarily unavailable: the provider remains registered, sign-in
returns a temporary error, and background retries recover without restarting. Discovery is lazy
on first use, refreshed in the background, and failures back off up to one minute. Availability
reflects discovery, not a guarantee that the provider's token endpoint is currently reachable.

Account deletion keeps the existing password confirmation for password users. Users without a
password may delete after explicit provider reauthentication within five minutes; **Sign in again** starts a fresh
provider round-trip bound to the signed-in account. Choosing a different identity cannot confirm
deletion or create another account in that flow. A stale or borrowed session alone cannot authorize deletion. With transactional
email configured, **Send deletion code** sends a single-use code to the account email, valid for ten
minutes. Enter it in account settings to confirm deletion. Email-code requests are rate-limited;
invalid, expired or wrong-account codes fail. No password needs to be created for deletion.

### Mobile push notifications

The API and worker send iOS and Android notifications through Expo's push service. If the Expo
project has [enhanced security for push notifications](https://docs.expo.dev/push-notifications/sending-notifications/#additional-security)
enabled, every send needs an access token; without one Expo rejects all pushes. Create an access
token in the Expo account that owns the project and set it for both services:

```env
EXPO_ACCESS_TOKEN=replace-with-your-expo-access-token
```

Leave it unset when enhanced security is off. A missing or revoked token fails the push with an
error that names `EXPO_ACCESS_TOKEN`; the token itself is never logged.

### Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. Rakazo uses a
provider-neutral contract with Resend API and SMTP adapters. Templates render locally with React
Email into HTML and plain text, independent of the sending provider.

To use the Resend HTTP API, verify a sending domain and create a sending-only API key restricted
to that domain, then configure:

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=replace-with-sending-api-key
EMAIL_FROM=Rakazo <hello@mail.example.com>
```

Disable click and open tracking for account email in the provider's domain settings. Resend delivery
has a ten-second deadline and bounded retries with the same idempotency key, including when a
response is lost. Errors omit provider response bodies and credentials.

For Amazon SES or another SMTP server, use:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Rakazo <no-reply@example.com>
```

Set `EMAIL_REPLY_TO` to send replies somewhere other than `EMAIL_FROM`.

`EMAIL_PROVIDER=smtp` is optional: an existing `SMTP_URL` continues to select SMTP when no provider
is specified. `EMAIL_PROVIDER=none` disables external sending. Explicit provider settings take
precedence over an old `SMTP_URL`; incomplete or unknown provider configurations fail at startup.

Resend also supports SMTP: use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. Rakazo rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

### Password policy

New passwords (signup, reset and change) must be 8 to 128 characters, with no composition rules.
Optionally reject new passwords that appear in known breaches:

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

This queries the Have I Been Pwned range API, sending only the first five characters of the
password's SHA-1 hash. It is off by default so the server makes no outside request. If the service
is unreachable or takes longer than three seconds, the password is accepted and the failure logged.

### Billing

Billing stays off unless `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both set (see
`.env.example`). Enabling billing offers a monthly own-key plan for a personal model connection or
monthly model credits in USD: $10, $20, $50, $100, $200, or $500. One-time top-ups use the same
amounts. Monthly credits expire at the end of their service period; one-time top-ups do not expire.
The hosted computer is included in both paths, and monthly credits include the own-key plan.

`BYOK_MONTHLY_PRICE_CENTS` in `@rakazo/contracts` sets the own-key plan's price; `null` makes it
free and ends paid own-key subscriptions at their period end. Runs check access on the server, so a
lapsed organization's bots and routines stop until it subscribes.

Configure the managed default model through the existing model connection settings. The default
OpenRouter model is Luna 6; customers can choose another available model, with its usage deducted
at model cost. In credit mode, the configured hosted provider uses Rakazo's key even when a personal
key for that provider is saved. Switching back to BYOK restores that connection. Personal connections
to other providers continue to use their own keys and never debit Rakazo credits. Hosted calls reserve an upper cost estimate atomically before starting, then settle
to reported or catalog-priced usage. Unknown usage retains its reservation for reconciliation.

`STRIPE_PRICE_ID` is optional and only needed to display the legacy seat price. Existing live seat
subscriptions retain their access and billing portal. Upgrades charge the prorated difference
immediately and add the amount collected to the credit balance; a failed payment leaves the plan
unchanged. Downgrades lower the next renewal without charging now or removing credits.
Credit purchases require settled payments; webhook
replays do not add credits twice, and refunds reduce the remaining account balance.

Monthly funds are spent before top-ups. Each grant has an audited allocation lot, so reservations
retain their funding source across renewal: unused monthly holds expire when released, while
purchased top-ups remain available. Prorated upgrades share the original period end. Expiration
creates a financial journal delta and runs before balance reads, reservations, settlements, and
background recovery. Unclassified legacy balances are preserved as non-expiring funds.

Postgres owns accounting. `billing_audit_events` is an append-only journal enforced by database
triggers; credit entries, usage rows, and balances are projections. Each managed call shares one
`callId` across reservation, durable provider receipt, usage, and settlement. Provider generation
IDs, token buckets, cost provenance, and pricing snapshots are retained. Usage and settlement
commit together, and journal/usage history survives clearing messages or deleting a bot or
organization. Corrections append evidence rather than rewriting earlier journal events. Existing
rows receive explicit baseline events when the migration runs; earlier history cannot be recovered.

The API/worker reconciler recovers saved receipts and, when supported by the configured provider,
fetches authoritative generation costs for interrupted calls and estimates. Retries use leases and
idempotent settlement. Unverifiable calls retain their holds and become `needs_review` after six
attempts. An hourly, paginated audit rebuilds drifted balance caches from the journal and records
repairs. Investigate `Model credit hold requires review` logs using the shared call ID; do not turn
missing provider evidence into a zero-cost settlement.

OpenRouter inference requests include the normal Rakazo user ID in `user`, `HTTP-Referer`
(`https://rakazo.com`), and `X-OpenRouter-Title` (`Rakazo`). These values are sent only to OpenRouter's
HTTPS inference endpoints, never to compatible custom hosts. Recovery uses the existing configured
deployment credential; no Redis or external accounting service is required.


The adapter pins Stripe API `2026-09-30.endive`. Configure webhook destinations for your own account,
using snapshot payloads on the same API version. Subscribe to all `customer.subscription` events,
`customer.deleted`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, and
`charge.dispute.closed`. Credit Checkout restricts payment methods to cards. New subscriptions
explicitly retain classic billing mode so API upgrades do not change invoice/proration behavior.

For local testing, forward Stripe test events to `/api/v1/billing/webhook`. Use the signing secret
from `stripe listen` and test API credentials; keep them in an ignored environment file.

### Pi tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the worker to enable optional OpenTelemetry traces
(for example, `http://otel-collector:4318`). The OTLP/HTTP exporter appends `/v1/traces`
to the base endpoint and honors standard `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated
`key=value` pairs) and `OTEL_SERVICE_NAME` (default `rakazo-worker`). Compose workers
read these settings from `.env`. With an empty or unset endpoint, no tracing SDK loads
or initializes. No collector or hosted service is required to run Rakazo.

Traces contain a `rakazo.agent.run` span with `pi.ai.request` model-call spans and
`pi.agent.tool` steps, including duration, token usage, cost when known, and success/error
status. Each span carries `rakazo.bot.id`, `rakazo.run.id`, and `rakazo.routine.id`
when the run belongs to a routine. Helper model calls inherit the same correlation.
Pi 0.87.1 exposes built-in telemetry through its newer harness; Rakazo’s legacy Agent
adapter maps its model and tool lifecycle through the same Pi telemetry contract.

Prompt, response, tool arguments and tool results are excluded by default.
`OTEL_CAPTURE_CONTENT=true` includes them: enable only with a trusted collector and
appropriate retention/access controls, since this content can contain secrets or personal
data. Unknown attributes and exception messages/stacks stay excluded. Export is batched,
best effort, and flushed when the worker shuts down; collector failures do not fail runs.

### Product analytics

Product analytics is off by default. To enable the PostHog adapter, set
`ANALYTICS_PROVIDER=posthog`, `ANALYTICS_KEY` to a project capture token, and
`ANALYTICS_HOST` to the HTTPS ingestion host (default `https://us.i.posthog.com`)
on API and worker. Also set `ANALYTICS_PSEUDONYM_SECRET` to a server-only random
value (`openssl rand -hex 32`), identical on API and worker. Retain it when rotating
the public capture token so user and event identities stay stable. Never send this
secret to the browser or collector. Set `ANALYTICS_PROVIDER=none` to disable it.
The public website uses its separate `PUBLIC_POSTHOG_KEY` configuration.

The backend sends account creation, session creation, fixed screen names, message
counts, and run starts/outcomes. Run events include the shared trigger enum;
analytics does not read or classify error text. User identifiers are pseudonymized
with the server-only secret. No names,
emails, prompts, responses, message text, DOM, URLs, search parameters, document
contents, request metadata, or raw errors are exported. There is no browser or
mobile analytics SDK, autocapture, session replay, or third-party script.
Web, Electron, and mobile send only fixed screen/surface enums to the authenticated
API; lifecycle events come from the shared backend. This works across clients
without giving a collector access to their content. Local and self-hosted
installations remain off until their backend is configured.

Delivery is best effort: memory is bounded, requests time out, and shutdown flushes
pending events. Analytics failure does not fail product operations. This is not a
durable audit trail, and events from before enablement are not backfilled.

### Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`rakazo-api`, `rakazo-worker`, `rakazo-sandbox-supervisor`,
`rakazo-updater`). A partial Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a
regional hostname; `AXIOM_EDGE_URL` must be https and wins when both are set.

Computer usage is recorded at several boundaries:

- `run.computer`: one record per execution attempt, including runs that never request a computer
  (`reason=none`). `reason` is `tool`, `takeover`, or `script` otherwise; `tool` is an allowlisted
  built-in name and `trigger` identifies user, routine, or other run sources. Deduplicate `run.id`
  when counting runs, because a run can have several attempts.
- `computer.requested`: the first computer use in an attempt, with its reason, tool, and trigger.
- `computer.provisioned`: completed setup, with `operation=create`, `resume`, or `reuse` and
  `durationMs`. A setup request can reuse an already-running computer without spending a start.
- `sandbox.start`: Boat's actual `create`, `resume`, and `recover` requests, including starts during
  preparation or after the provider expires a computer. `outcome=accepted` means the provider
  accepted the request, not that all later setup succeeded. `rate_limited` and `failed` are
  separate outcomes. Count accepted creates/resumes for start usage; recoveries are shown separately
  because their quota treatment depends on the provider.
- `computer.suspended`: successful idle or active-limit suspension, with the active duration.

These records use fixed metadata, opaque correlation IDs, durations, and booleans. They do not add
prompts, responses, filenames, file contents, command arguments, or credentials. Request/job trace
fields link non-run starts back to the API route or background job that initiated them. Axiom is
an additional sink for the same logs; these events need no extra keys when ingest is configured.

For example, substitute your own dataset in these APL queries:

```apl
['YOUR_DATASET']
| where message == 'sandbox.start'
| summarize requests=count() by provider, operation, outcome
```

```apl
['YOUR_DATASET']
| where message == 'computer.requested'
| summarize requests=count() by trigger, reason, tool
```

```apl
['YOUR_DATASET']
| where message == 'run.computer'
| summarize attempts=count(), withoutComputer=countif(reason == 'none') by trigger
```

Track accepted starts per hour/day, rate-limit refusals, first-use tools, and the proportion of
attempts needing no computer before tuning `SANDBOX_IDLE_MS`. Increasing the idle window reduces
resumes between nearby uses but increases billed runtime; changing it does not remove unnecessary
starts caused by tools. Provider rolling-window limits remain the source of truth for quota.

Error reporting to Sentry or a Sentry-compatible collector such as GlitchTip is optional:

- `SENTRY_DSN` reports backend `error` logs, with the exception chain, `service`, and request or job
  ids as tags. Uncaught exceptions are reported before exit.
- `SENTRY_BROWSER_DSN` reports web app errors. The browser reads it from `/api/monitoring/config` at
  startup and posts reports to `/api/monitoring/tunnel`; the API forwards only envelopes addressed
  to that DSN. Use a separate project from `SENTRY_DSN`.
- `SENTRY_ENVIRONMENT` names the deployment. `SENTRY_RELEASE` defaults to the image's `GIT_SHA`.

Desktop and mobile use the connected server's `SENTRY_BROWSER_DSN`. Electron sends crash metadata
without memory dumps. Mobile native reporting requires a rebuilt app; Expo Go is unsupported.
For readable mobile crash stacks, build with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
and optional `SENTRY_URL` to upload symbols.

Neither SDK sends cookies, headers, request bodies, user identity, console output, or log context.
When `ANALYTICS_PSEUDONYM_SECRET` is set, reports carry a keyed hash of the signed-in user's id so
the collector can count affected users; the raw id, email and IP address are never sent, and the
browser receives its hash from the API. Reporting is off without a DSN; an invalid DSN logs a
warning and stays off.

Compose passes these into the API, worker, supervisor, and updater. Computer containers and updater
child commands do not receive them.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, novita, daytona, createos, boat. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause or stop after 10 minutes idle; 0 disables idle sleep
# Set 0 when self-hosting with Docker, where an idle computer costs nothing, to keep long-running apps and sessions up.
# E2B, CreateOS and Boat still apply their own timeouts.
COMPUTER_MAX_ACTIVE_MS=7200000 # uptime cap for providers that bill while running; minimum 60000; 0 disables
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user length cap; narration stays at 500
BOT_MESSAGE_MAX_HOPS=6    # bot-to-bot messages one chain may carry before the next is refused
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
NOVITA_API_KEY=           # when SANDBOX_PROVIDER=novita; build its template first
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOAT_API_KEY=             # when SANDBOX_PROVIDER=boat
```

`RAKAZO_LIVE_MODEL_CATALOG=off` disables provider and Codex live catalog probing; the default is on.

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
```

The loopback default is suitable when running Rakazo from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Rakazo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

### Ollama Cloud

In **Settings → Models**, choose **Ollama Cloud**, paste an API key from ollama.com, then **Find models**. This uses an OpenAI-compatible connection with no environment configuration, and stays available when `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0`.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Add optional request headers under **Advanced**; values are stored encrypted, and only their names
are shown afterwards.
Public hosts and ordinary hostnames need HTTPS when they receive an API key or custom headers,
and must resolve only to public addresses. Set `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` on the API
and worker to block them.
Literal private IP, loopback, and `host.docker.internal` targets do not, but only the deployment
owner can use them, checked on save, on model discovery, and on every run. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow them for every user.
For a self-hosted endpoint whose hostname resolves to private IPs, set
`RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS=models.example.test,other.example.test` in the deployment
environment for both API and worker, then recreate those containers. Entries are exact hostnames
(case-insensitive, optional trailing dot), not URLs, suffixes, or wildcards. These hosts ignore
`RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC`; every DNS answer must be private, and metadata and
link-local destinations remain blocked. This applies to discovery and model requests.
HTTPS still validates the hostname's certificate. Like private IP endpoints, trusted hostnames
also permit HTTP with API keys; use HTTPS unless the network is trusted. Only allow hosts you
control. Private endpoints require `MCP_ALLOW_PRIVATE_ENDPOINT=true` for the deployment; no app account bypasses that policy.
If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

### Client updates

Every web build is named by the UTC time it was built (`YYYYMMDDHHMMSS`). The web app sends its
build on each `/rpc` request in `x-rakazo-client-build` (`web/20261022093015`; the mobile app sends
`mobile/` and the time its JavaScript bundle was built), and the API answers with the web build in
its own image in `x-rakazo-build`. An open tab that sees a newer build reloads at a safe moment:
while hidden, on its next navigation, or after a few idle minutes with nothing typed.

To retire old clients immediately, set `RAKAZO_MIN_CLIENT_BUILD` on the API, for example
`web=20261022093015` or `web=20261022093015,mobile=20261001000000`, and restart it. Older clients
get HTTP 426 `CLIENT_UPDATE_REQUIRED`: the web app reloads, and the mobile app offers its update.
Read the current build from the `x-rakazo-build` header of any `/rpc` response. Requests that name
no build, such as webhooks and API tools, are never refused. A malformed value stops the API from
starting rather than being ignored.

### Client addresses

Sessions, logs, and security events carry the caller's address. The API believes a forwarded
header only when the TCP peer is in `TRUSTED_PROXIES` (IPs, CIDR ranges, or hostnames such as a
Compose service name). It reads that header (`CLIENT_IP_HEADER`, default `x-forwarded-for`) right
to left past trusted hops. Anyone else is the TCP peer, so a client cannot choose its own address.
Unset, `TRUSTED_PROXIES` in a container is `local-networks`: loopback and every network the API
has an interface on. Outside a container it is loopback only, since the host's networks can hold
direct clients. `none` trusts no proxy. In Compose those networks are the stack's own, which hold the web container and the network
gateway a reverse proxy on the Docker host connects from, so a host proxy that sets
`X-Forwarded-For` (Caddy does; nginx needs `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for`) is believed without configuration. Bot computers are never on those
networks, so they cannot choose an address. Production Compose sets `caddy` instead. For any
other layout, list every proxy between the internet and the API. Sign-in rate limits count per
client address, so a proxy that is not believed makes every user share one limit.

Caddy resolves the client first. `Caddyfile.prod` takes the TCP peer and overwrites
`X-Forwarded-For` with it. Behind a CDN, Caddy has to trust the CDN's ranges and read its client
header: `Caddyfile.cloudflare.example` does this with Cloudflare's ranges and `CF-Connecting-IP`.
For another CDN, copy that file and change the ranges and the header. If you copied the Cloudflare
example before this change, copy it again.

### Content-Security-Policy

The web server sends a strict Content-Security-Policy: scripts and connections are limited to the
app's own origin. When a CDN in front of the app injects a script, such as an analytics beacon, the
browser blocks it until you add its origins. `RAKAZO_CSP_SCRIPT_SRC` extends `script-src` and
`RAKAZO_CSP_CONNECT_SRC` extends `connect-src`. Each takes space-separated `https://` origins, with
an optional port and leading `*.` wildcard (`https://*.example.com`). Keywords such as
`'unsafe-inline'`, bare schemes, `*`, `http://` origins and paths are rejected, and the web server
refuses to start until the value is fixed. Restart the web service after changing either one.

For example, Cloudflare Web Analytics loads its script from one host and reports to another:

```bash
RAKAZO_CSP_SCRIPT_SRC=https://static.cloudflareinsights.com
RAKAZO_CSP_CONNECT_SRC=https://cloudflareinsights.com
```

Add only origins you trust: a script these settings allow runs with the signed-in user's access.

Browsers report what the policy blocks to `/api/csp-report`. The API writes one `csp.violation`
warning per violation, with the directive, the blocked origin and the page path, so search your logs
for it to find the origins to add.

### Menu links

`RAKAZO_NAV_LINKS` adds items to the account menu that open a page from the same domain inside the
web app, such as an internal tool your reverse proxy serves next to Rakazo. Set it on the API:

```bash
RAKAZO_NAV_LINKS='[{"id":"clients","label":"Clients","path":"/ext/clients/"}]'
```

Each `id` is lowercase letters, digits and dashes, and becomes `/app/x/<id>`. `path` must start with a
single `/` and must not be under `/app`, `/api`, `/rpc`, `/novnc` or `/health`. Route it before the
catch-all in your proxy, for example `handle /ext/* { reverse_proxy office:8080 }` in
`Caddyfile.prod`. A malformed value stops the API from starting.

Pages open sandboxed with an opaque origin, so they cannot read Rakazo's pages or act with the
signed-in user's session; that also blocks their own cookies and storage. Add `"trusted": true` to a
link only for a service you control: a trusted page runs with the signed-in user's access, like a
script allowed by `RAKAZO_CSP_SCRIPT_SRC`. The page must allow framing by the app
(`frame-ancestors 'self'`). Links appear in the web app only; the desktop and mobile apps hide them.

### Security events

The API and worker append a row to `security_events` and write a `security.event` log line for:

- sign-up, sign-in, sign-out, and failed sign-in or sign-up
- session revocation, password and passkey changes, and account deletion
- model, MCP, connector, voice, memory, and secret credentials created, changed, or removed
- deployment settings changes, approval decisions, and approval policy changes
- refused private or internal destinations (`egress.refused`) and auth rate-limit hits

Each event has the user, space, client address, user agent, time, and a few identifiers. Events
never include message content, secrets, or tokens. Rows older than `SECURITY_EVENT_RETENTION_DAYS`
(default 90) are deleted, and Postgres rejects updates to the rows that remain.

Operators read recent events through server-side database/log tooling. For example, query Postgres:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec postgres \
  psql -U rakazo -d rakazo -c 'SELECT "createdAt", type, ip, "userId", "userAgent", metadata
  FROM security_events ORDER BY "createdAt" DESC LIMIT 50'
```

Caddy writes a JSON access-log line for each request to stdout. The lines exclude
`Authorization`, `Cookie`, and `Set-Cookie`, and URL tokens are replaced with `REDACTED`. Docker
rotates container logs and drops them when it recreates a container. To keep Caddy's lines, ship
container stdout to your log sink with a collector. Security events reach the sink through the
API's own log shipping, and Postgres keeps them too.

### What to alert on

The queries below are pseudo-SQL over the JSON log lines, so translate them to your log sink. Field
names are the literal keys in each line: `message`, `security.event.type`, `client.ip`,
`user_agent.original`, `user.id`, and the `security.event.metadata` object. Tune the thresholds to
your traffic.

Sign-up bursts from one address:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE message = 'security.event' AND "security.event.type" = 'auth.sign_up'
GROUP BY "client.ip", bucket(1 hour) HAVING count(*) > 3
```

Password guessing, from one address and across many:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE "security.event.type" IN ('auth.sign_in.failed', 'rate_limit.hit')
GROUP BY "client.ip", bucket(15 minutes) HAVING count(*) > 10;

SELECT count(DISTINCT "client.ip") FROM logs
WHERE "security.event.type" = 'auth.sign_in.failed'
GROUP BY bucket(15 minutes) HAVING count(*) > 50
```

Probes of internal addresses. Any hit deserves a look:

```sql
SELECT "user.id", "security.event.metadata.host", "security.event.metadata.reason", count(*)
FROM logs WHERE "security.event.type" = 'egress.refused'
GROUP BY 1, 2, 3
```

Scripted clients on account routes:

```sql
SELECT "client.ip", "user_agent.original", count(*) FROM logs
WHERE "security.event.type" LIKE 'auth.%'
  AND ("user_agent.original" IS NULL
    OR lower("user_agent.original") SIMILAR TO '%(curl|wget|python|go-http-client|headless|okhttp|java/)%')
GROUP BY 1, 2
```

Credential and settings changes from an address that user has not signed in from:

```sql
SELECT * FROM logs c
WHERE (c."security.event.type" LIKE 'credential.%'
    OR c."security.event.type" = 'deployment.settings.changed')
  AND NOT EXISTS (SELECT 1 FROM logs s WHERE s."security.event.type" = 'auth.sign_in'
    AND s."user.id" = c."user.id" AND s."client.ip" = c."client.ip")
```

### Prompt cache capabilities

The model connection API accepts `cacheCapabilities`, including `scope`,
`retentionMs`, `minimumTokens`, and `retentionMode`. Declare a positive
`retentionMs` only when the endpoint supports prefix reuse for that window.
For these connections with usable history-retrieval tools, the runtime
automatically uses cache-aware context:
recent history remains bounded on a cold request, and subsequent requests keep
that selected prefix while it is likely warm and fits the context budget.
Connections with unknown retention or `retentionMode: "none"` retain the default
retrieval policy. An explicit executor context strategy still takes precedence.
Callers without usable history-retrieval tools keep fitting original history
under the model's context budget instead of replacing it with snapshots.

Cache warmth is advisory. Changing instructions or tools, context pressure,
worker eviction, or a process restart can require fresh prompt processing.
These settings do not create backend KV snapshots or keep a model loaded;
the inference server is responsible for retention and conversation switching.

### Web search and page reading

Builtin `web_search` and `web_fetch` use keyless HTTP search (DuckDuckGo HTML) and local
Readability extraction by default. To choose [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp),
set `WEB_PROVIDER=parallel` in `.env` and restart both the API and worker. The same bot tools
then return search excerpts and extracted page markdown through HTTPS MCP at
`https://search.parallel.ai/mcp`. Search uses Fast mode without an account or API key.

This option sends search queries and requested page URLs to Parallel, which retrieves pages
on its servers. Conversation accounting uses an HMAC of internal IDs keyed by
`ENCRYPTION_KEY` (shared by the API and worker), so deployments with distinct secrets send
distinct session IDs. Rotating that secret resets the session IDs; the existing development-only
encryption-key fallback also applies here. Anonymous access has service limits; rate-limit and provider errors are returned
to the bot without switching providers. Per-bot disabled web tools remain disabled. Set
`WEB_PROVIDER=keyless-http` (or remove the setting) to return to the default.

To choose [Keenable](https://docs.keenable.ai) instead, set `WEB_PROVIDER=keenable` and restart
both the API and worker. The same bot tools then return search snippets and extracted page
markdown through HTTPS MCP at `https://api.keenable.ai/mcp`, without an account or API key. This
option sends search queries and requested page URLs to Keenable, which retrieves pages on its
servers. Anonymous access is rate limited per IP address; set `KEENABLE_API_KEY` on the API and
worker to send a key and lift those limits. Errors, per-bot disabled tools and the way back to
the default work as described for Parallel.

### Self-hosted memory

Supermemory and Honcho can run on your own network. In **Settings → Memory**, choose **Local**
and enter the instance's base URL. The operator must set `MCP_ALLOW_PRIVATE_ENDPOINT=true`; workspace owners can then save a local endpoint. It must
be loopback or resolve to private addresses (a Compose service name, an RFC1918 or unique-local
address, or a `.internal` name such as Railway's private network); Rakazo pins the resolved
address for every request. Space members use the saved connection without seeing its key.

For [Honcho](https://github.com/plastic-labs/honcho), enable `AUTH_USE_AUTH` on the Honcho
server and use an admin JWT from its `scripts/generate_jwt.py --admin` as the key, so each Space
gets its own workspace. A workspace-scoped JWT works when you enter that workspace. Honcho needs
its own PostgreSQL with pgvector, an LLM provider, and an embedding provider; set
`EMBEDDING_VECTOR_DIMENSIONS` before its first start. Rakazo stores only explicitly saved facts
in Honcho; conversation summaries stay in Rakazo. Bots can forget a saved fact on Honcho v3.2 or
later.

Remote MCP servers and installed API / GraphQL connectors default to public HTTPS. The deployment
owner can attach one on localhost, the same LAN, or a Docker network. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow these for every user. Cloud
metadata addresses stay blocked. Leave the flag unset on public installs.

Remote MCP servers that use OAuth normally register Rakazo with their provider on the first
**Connect OAuth**. Some providers only accept a client you create in their console. For those,
enter the client ID (and secret, for a confidential client) under **Advanced** when adding the
server, and add the **Redirect URI** shown there (`<your web origin>/mcp/oauth/callback`) to the
client's allowed redirect URIs. The client is stored encrypted with the server's other
credentials and survives **Disconnect**; switching to a different client drops the current grant.
On first use the client is bound to the authorization server the MCP server pointed to, and Rakazo
refuses to send it anywhere else afterwards. Replacing the client clears the binding.

Stdio MCP servers can use OAuth too. They do not authorize themselves (the MCP spec has them
read credentials from the environment), so Rakazo runs the flow for them. They are off unless
the API and worker have `MCP_STDIO_ENABLED=true` and the command is listed in
`MCP_STDIO_ALLOWED_COMMANDS`. When adding the server, enter the OAuth client, its
**Authorization server** (the issuer, for example `https://accounts.google.com`) and the
**Scopes**, then click **Connect OAuth** as for a remote server. Some providers issue a refresh
token only when asked through extra parameters: for Google, set **Authorization parameters** to
`access_type=offline&prompt=consent`. Pass the grant to the process
through its environment variables:

- A value can reference `{{oauth.access_token}}`, `{{oauth.refresh_token}}`,
  `{{oauth.client_id}}`, `{{oauth.client_secret}}`, `{{oauth.expires_at}}` (epoch milliseconds),
  `{{oauth.scope}}` or `{{oauth.token_type}}`, alone or inside other text.
- A variable can be a **File** instead: its template (often JSON, with the same references) is
  written to a private temporary directory when the process starts, and the variable receives
  the file's path. Use this for packages that read a credentials or token file path.

Rakazo refreshes the grant and restarts the process shortly before an access token it passed
expires, so a long-running process never keeps a dead token. A process that only receives the
refresh token refreshes on its own. Temporary files are removed when the process stops.

A server launched as `npx [-y] <package>[@version]` (or `npx -p <package> <bin>`) is not
downloaded on every start. Rakazo installs the package once with `npm install` into
`MCP_PACKAGES_DIR` (default `DATA_DIR/mcp-packages`, shared by the API and worker), then runs
its bin directly; `npx` must still be in `MCP_STDIO_ALLOWED_COMMANDS`. The install has its own
timeout, `MCP_STDIO_INSTALL_TIMEOUT_MS` (default 180000), separate from the handshake timeout
`MCP_STDIO_STARTUP_TIMEOUT_MS` (default 30000). Pin a version so every start runs the same
code; npm settings such as `NPM_CONFIG_REGISTRY` can be set in the server's environment
variables. Local paths, git and tarball URLs, and unknown `npx` flags fall back to running the
command as configured. Each server runs as one process per user in each of the API and worker,
shared by that user's bots, and stops after `MCP_STDIO_IDLE_MS` (default 900000, 15 minutes)
without use. When a server fails to start, the reason (including the end of its stderr, with
credentials redacted) appears on the server in **Settings**, and its bots are told it is
unavailable instead of silently losing its tools.

A run never waits long on one server. It gives each server `MCP_DISCOVERY_TIMEOUT_MS` (default
20000) to list its tools, then goes on without it; a package still installing finishes in the
background and its tools appear on a later turn. After a failure, runs skip that server for 30
seconds, doubling up to 5 minutes while it keeps failing. A successful **Test connection** or
discovery, or a change to the server's settings, ends the wait at once.

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Rakazo sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

Optional messaging platforms (iMessage, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. The Lark adapter and official SDK load only when configured. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Personal group linking stays iMessage-only; Slack channels use workspace installations below. Telegram can run several bots side by side (`TELEGRAM_BOT_TOKEN_<NAME>` plus `TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>`), for example one per space, so the same person can chat with a different Rakazo bot through each.

For Slack workspace installations, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
`SLACK_SIGNING_SECRET` on the API and worker. Register the OAuth redirect URL
`https://app.example.com/api/v1/messaging/install/slack/callback` using your public
API origin (`API_URL`). Enable distribution in the Slack app's Manage Distribution
settings so other workspaces can install it. Enable Slack Events API delivery to
`https://app.example.com/api/v1/messaging/webhook/slack`, with `app_mention`,
`message.im`, `message.channels`, `message.groups`, `message.mpim`, and
`app_uninstalled`. Enable the app's Messages tab. The install flow requests the
message/history, channel/user lookup, file read and write, and reaction-write scopes it uses;
reinstall the Slack app after changing scopes. Socket Mode is not used.

In Messaging settings, select **Connect** on the Slack row. The workspace answers as
the first bot in your default space, whichever space is open. Each Slack workspace
belongs to one Rakazo space and one installation owner; installing it from another
space is rejected. To DM that bot, use **Link DMs** and send the code in a DM to the
Slack app. Teammates in the same space can link their own bots the same way.
Invite the Slack app to channels and mention it to receive replies there. The
bot's external conversations offer **Mentions only**, **Listen**, and room guidance.
Workspace setup and personal linking are available on web, desktop and mobile.
Mobile opens Slack authorization in the system browser; return to the app when it
finishes. Channel listening settings currently live in the web/desktop interface.

Tokens are encrypted with the configured secret store. Workers resolve the
installation for every outbound operation, including queued replies; disconnecting
an installation stops further delivery and unlinks its personal DMs. Slack's signed
`app_uninstalled` event also removes the installation. Disconnect removes Rakazo's
local credentials; remove the app in Slack to revoke Slack's installation itself.
The installation owner must retain space membership and an active bot. Workspace
installations require a workspace-level bot token without Slack token rotation;
Enterprise Grid org-wide installs and rotating tokens are rejected explicitly.

The older `SLACK_BOT_TOKEN` plus `SLACK_SIGNING_SECRET` configuration still supports
a single workspace. OAuth mode takes precedence when configured; existing static
Slack identities/conversations must be relinked before using workspace installs.
`TEAM_CHAT_BOT_ID` only selects a channel bot for the static configuration. It does
not override workspace installations or personal DMs. Slack tools authorized from
the Integrations screen are a separate connection from this messaging surface.


### Settings with names you choose

The Compose files pass the API and worker only the settings each one reads, listed by name, rather than the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>`, therefore needs its own line: add it under `api` and `worker` `environment` in an override file layered after the base file (and in `RAKAZO_COMPOSE_FILE` when the updater is enabled), with no value so Compose fills it from `.env`. `install-images.sh` names any `.env` setting that no container receives.

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
  worker:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
```

`install-images.sh` layers a `docker-compose.override.yml` next to it automatically. In your own
commands, add `-f docker-compose.override.yml` after the base file.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker remains the default. For an app-managed local instance, the local operator can choose **Use this Mac** (macOS) or **Use this computer** (Windows/Linux). After native confirmation, an authenticated bridge sends commands from the Docker backend to Electron, where they run under your OS account. **Computer Access…** in the app menu changes the choice; **Revoke Local Computer Access** immediately disconnects active operations and revokes the saved permission. Local execution requires the desktop app to remain running. Connecting to an existing remote instance does not grant it access to your computer. Browser and mobile clients use the deployment’s configured computer; they do not expose their own host. `SANDBOX_PROVIDER=desktop` is a separate, development-only configuration for backends running directly on the intended host.

Native file reads and workspace exports are limited to 8 MiB per file. A larger workspace file fails the checkpoint and preserves the previous saved workspace; local files remain on the computer. Writes are bounded by the 12 MiB encoded request limit.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and published `ghcr.io/elie222/rakazo/computer` image. No E2B account required.
  Optional: set `e2b`, `novita`, `daytona`, `createos`, or `boat` plus the matching API key for remote computers.
- **Docker** is the quick-start default for published images and for a source checkout / full local
  Compose stack. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Keep the supervisor private, as the included Compose files do.
- **E2B** runs bot computers away from the Rakazo host and is a good choice for public or multi-user
  production deployments. Rakazo checkpoints the portable workspace and browser-profile directory to
  `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure
  `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET` / `DAYTONA_SNAPSHOT`.
- **CreateOS** provides the same remote-computer contract through CreateOS desktop sandboxes.
  Configure `CREATEOS_SANDBOX_API_KEY` and optionally `CREATEOS_SANDBOX_BASE_URL`,
  `CREATEOS_SANDBOX_SHAPE`, or `CREATEOS_SANDBOX_ROOTFS`. Rakazo defaults to
  `https://api.sb.createos.sh`, `s-2vcpu-2gb`, and `desktop:1`.
- **Boat** provides a managed Linux desktop through `BOAT_API_KEY` and optionally
  `BOAT_API_URL`. Rakazo always creates or resumes sandboxes with `noEnv: true`, keeps the portable
  workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. Boat uses the shared Linux
  desktop runtime and protected port routes for concurrent bot desktops. Each bot has its own
  persistent Chrome profile; logins are not shared between bots.
- **Local computer access** in the app-managed Electron instance runs commands on Windows, macOS,
  or Linux through the native bridge. Bots can read/change local files and launch installed apps
  through OS commands, subject to your account and OS permissions. Portable file tools and
  checkpoints remain scoped to bot workspaces; use commands for other local folders. Graphical
  screen control is unavailable. Permission is remembered locally and can be revoked from the
  app menu. Only enable this for a trusted personal instance: every bot on that instance can use
  your account’s permissions.
- **Desktop provider** (`SANDBOX_PROVIDER=desktop`) runs commands directly on the API/worker host,
  with only a minimal shell environment (no server secrets). The API and worker refuse it unless
  `NODE_ENV` is `development` or `test`, so a production server never runs bot commands on itself.
  Setting this inside a container does not grant access to the physical computer. Docker deployments
  use the authenticated native bridge when local computer access is selected; they never silently
  fall back to executing on the backend host.
- **Fake** is only an emulator for verification.
- **None** boots the product without a computer host (fallback when Docker/supervisor is not
  configured, or when a remote provider is selected without its API key).

For provider configuration and health checks, see the [provider setup guide](./self-host-sandbox-providers.md).

## Content encryption

Rakazo encrypts chat messages, thread events, compacted history summaries, memory documents and
their revisions, and uploaded or generated files before they reach PostgreSQL or `DATA_DIR`.
Names, ids, timestamps and other metadata stay readable. Credentials are always encrypted,
whatever this setting says. Details and the threat model are in
[content encryption](./content-encryption.md).

**The key.** Content is encrypted under keys derived from `ENCRYPTION_KEY` (and
`ENCRYPTION_MASTER_KEYS`, if set). Without them, a backup of the database and `DATA_DIR` cannot
be read, by you or by anyone else. `install-images.sh` says so once, when it generates the key:

```text
Back up ENCRYPTION_KEY from /path/to/rakazo/.env. Encrypted content cannot be recovered without it.
```

It never prints the key. Store a copy somewhere other than the server and its backups.

**The switch.** `CONTENT_ENCRYPTION=on|off` in `.env`:

| Install | Unset means |
| --- | --- |
| Compose files, published images, Railway | `on` |
| Desktop app, **This computer** | `off` (the computer's disk encryption covers it) |
| Source checkout with `NODE_ENV=development` or `RAKAZO_ALLOW_DEV_SECRETS=1` | `off` |

With `off`, new content and files are stored readable, so you can query your own database
directly and a lost key cannot lose them. Content encrypted earlier still reads with the key, so
switching off never makes data unreadable. To convert it too, run `content-encryption decrypt`.
Any other value stops the API and worker at startup.

To switch on later, set `CONTENT_ENCRYPTION=on`, restart, then encrypt what was stored while
it was off. From the published-images folder (other stacks use their own Compose file):

```bash
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption migrate
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption status
```

Search works in both modes and while rows are mixed.

**Reading your data.** `content-encryption export` writes decrypted threads, messages, memory
documents and revisions as JSON lines. It reads the whole database by default; narrow it with
`--space <id>`, `--thread <id>` or `--bot <id>`. It only reads.

```bash
docker compose -f docker-compose.images.yml exec -T api \
  pnpm -s --filter @rakazo/api content-encryption export --bot <bot id> > rakazo-export.jsonl
```

The export is plaintext: store it like the database itself. Files are not included; use
`content-encryption decrypt` to make them readable on disk.

## Bot homes in object storage

Each bot computer has a home: its files, logged-in browser profiles and CLI tokens. By default
homes live under `DATA_DIR/homes` on the server. Set `OBJECT_STORAGE_BUCKET` to keep them in any
S3-compatible bucket instead, so `DATA_DIR` is only a cache and API and worker hosts no longer need
a shared disk for homes. Leave it unset to keep homes on local disk, as before.
The same connection also stores new artifacts; see [shared storage migration](#shared-storage-migration)
for migrating existing files and push registrations.

```env
OBJECT_STORAGE_BUCKET=rakazo-homes
OBJECT_STORAGE_ENDPOINT=https://storage.example.com
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ACCESS_KEY_ID=replace-me
OBJECT_STORAGE_SECRET_ACCESS_KEY=replace-me
# Optional: a key prefix, when the bucket holds anything else.
OBJECT_STORAGE_PREFIX=
# Optional: true for services that address buckets in the path rather than the host name.
OBJECT_STORAGE_PATH_STYLE=false
```

Only the API and worker read these settings. Bot computers never receive the credentials or
links to stored objects; files still reach them through the server, as before. The settings
apply to every provider, including Docker computers, which keep mounting their cached home.

**Encryption.** Homes are encrypted on the server before upload, whatever `CONTENT_ENCRYPTION`
says; the bucket only ever holds ciphertext. Each home has its own random data key, kept on the
computer's database row and wrapped by its space's content key (see
[content encryption](./content-encryption.md)). Each stored revision is one object, sealed in
authenticated segments bound to that home and revision, so a modified, truncated or swapped
object fails to restore instead of restoring the wrong files. Object keys are random ids
(`homes/<id>/<revision>`) that name no bot, user or space. Back up the database and the
encryption keys as before: the bucket cannot be read without them.

**The bucket.** Use a private bucket, or a prefix of one, for this deployment alone: the worker
deletes objects under `homes/` that no home in this database owns. Block public access. The
credentials need to read, write, list and delete objects in it, and nothing else. Turn on bucket
versioning, with a lifecycle rule that expires noncurrent versions after your backup window, so
a mistaken deletion can be undone. `scripts/backup.sh` does not copy the bucket; versioning, or the
service's own replication, is its backup.

**What is stored.** Each save uploads the whole home as one object (in parts of up to 16 MiB for
large homes) and then deletes the previous one, so a home costs about one object however many
files it has. Homes are saved when a run finishes or fails, before a computer stops, and before
it sleeps, as before.

**Deleting.** Deleting a bot with its own computer, or a space (including the personal spaces
removed with an account), deletes each home's key with its computer's row, so the stored objects
become unreadable at once. The worker deletes those
objects within the hour, along with any revision an interrupted save left behind.

**The cache.** `DATA_DIR/homes` holds a copy of homes in use. A copy whose revision matches the
bucket is downloaded again whenever it is missing, so you can remove it. Docker computers work
directly in their copy until their next save, so only remove the copy of a Docker computer that
is stopped. Remote computers save straight from their files to the bucket; the worker removes
their copies after an hour unread. Homes never saved to the bucket keep their only copy.

**Saving large homes.** A save streams files through `DATA_DIR/staging` on the data volume,
so memory use does not grow with file or home size. A computer with more than 20 GiB or a
million files, or more than the volume has free, is not saved and keeps running; the worker logs
`computer.sleep_deferred` with reason `too_large` or `too_many_files`. Staging left by a killed
process is removed at startup and by the worker within minutes.

### Moving existing homes

After setting the bucket, restart the API and worker. Each home is uploaded the next time it is
saved; until then its local copy is used. To upload the rest at once, run this where `DATA_DIR`
is mounted. It skips homes already stored, so it can be stopped and run again. Each upload is
downloaded and checked before the home counts as moved. It never deletes local files.

```bash
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api home-storage migrate --dry-run
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api home-storage migrate
```

Homes listed as having no computer belong to bots that no longer exist; they are left alone.
Once a run reports no failures and nothing left to upload, remove the local copies: stop Docker
computers, stop the API and worker, move `DATA_DIR/homes` and `DATA_DIR/home-revisions` aside,
start them again and check a few bots' files, then delete the moved directories.

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. Backup
directories have mode `0700`, and both artifacts have mode `0600`, including on reused paths.
A missing `data/` or `RAKAZO_BACKUP_SKIP_HOMES=1` produces an empty archive that restore treats
as omitted homes. Database or archive errors fail the backup. Discard the output directory of
any failed run.

## Moving an account between installs

To move from Rakazo Cloud to your own install (or back), use **Settings → Export data** on the
old install and **Import data** on the new one. The export is a zip of every space you belong
to: bots, chats, files, memory, routines, skills, bot workspace files and, in spaces you own,
the board. Content is decrypted inside the zip, so keep it private. Importing creates new
spaces you own. Routines arrive switched off. Credentials and connections (model keys, apps,
MCP servers, messaging) stay behind, so connect them again on the new install. Workspace files
over 8 MiB are left out, the export must stay under 4 GiB, and the upload must finish within
the server's request timeout (5 minutes by default in Node).

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers — `infra/compose/docker-compose.prod.docker.yml` is the opt-in
overlay that runs local Docker computers on the same stack (see below). The root-equivalent updater
sidecar is an explicit opt-in profile.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo --preserve-env=SSH_CONNECTION DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   `OPENROUTER_API_KEY`, the API key for your selected sandbox provider,
   `RAKAZO_HOST`, and the three public origins. Set `RAKAZO_DEPLOY_DIR` when the checkout is not at
   the supported Linux default, `/srv/rakazo`. Use URL-safe random values for database credentials.
   If you enable the `updater` profile, also set a dedicated `RAKAZO_UPDATER_TOKEN` (at least 32
   characters) that differs from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and
   `SCREEN_PROXY_SECRET`.
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
RAKAZO_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/rakazo/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
# e2b, novita, daytona, or boat
SANDBOX_PROVIDER=e2b
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/rakazo is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" below.
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
# Optional: required only with `--profile updater`.
# RAKAZO_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Build, do not pull, for a first deployment.** `RAKAZO_IMAGE_TAG` ships as `local`, a tag no
registry serves, so the commands above build `api`, `worker`, and `web` from the checkout you just
cloned. The opt-in command under [Updater sidecar](#updater-sidecar) builds `updater` when needed.

The public `/health` only reports liveness. Runtime, sandbox, and revision details stay on the API
port at `/internal/health`, which the edge does not route:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.text()).then(console.log)"
```

Passing `GIT_SHA` is what makes `/internal/health` report a `"revision"`; a locally built image has no
other way to know its commit. Prebuilt images from the registry bake it in at publish time, so
switching to a release tag needs nothing more: the containers report the revision the image was built
from, not a `GIT_SHA` in `.env`.

Once a release has been published you can switch this host to prebuilt images by setting
`RAKAZO_IMAGE_TAG` to that release tag and running `pull` followed by `up -d --wait --pull never`.
See [Published images and tags](#published-images-and-tags) for the tag contract.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes. The `webassets` volume keeps the hashed web assets
of recent builds (up to 20, each for a week after it is replaced), so open tabs keep loading after an
update; it needs no setup and can be deleted at any time.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
published application/updater builds pin their base-image digests. Refresh those pins deliberately
when taking upstream security updates; changing only the visible major tag does not change the
content while a digest is present.

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/rakazo-backup` and enable the supplied `rakazo-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/rakazo`, with mode
`0600`. It keeps up to `RAKAZO_BACKUP_KEEP` verified snapshots (default `3`), bounded by
`RAKAZO_BACKUP_MAX_GB` (default `50` GiB), and reserves `RAKAZO_BACKUP_MIN_FREE_GB` (default `5`
GiB) of free disk space. Before starting, it removes abandoned partial snapshots and excess history,
then checks capacity by scaling only the previous appdata archive by appdata source growth,
plus the previous database dump size. Snapshots without source-size
metadata use the raw source size for their initial estimate. It preserves the newest
verified snapshot when capacity is insufficient, caps output file sizes, and removes a failed run's
partial snapshot. Local snapshots alone do not survive losing the host; encrypt them and copy them
off-site as described below.

#### Encrypted and off-site backups

Backups are encrypted with [age](https://age-encryption.org) to public recipients only, so the host
can write backups it cannot read. Generate the key pair on a machine you control, not on the server,
and keep the identity file (the private key) offline, ideally with a second recipient held by
another operator:

```bash
age-keygen -o rakazo-backup.key   # prints "Public key: age1..."
```

`harden-host.sh` installs `age`; on other hosts run `apt-get install age`. Then set the public keys in
`/etc/rakazo/backup.env`, separated by spaces, or point at a recipients file with one key per line:

```env
RAKAZO_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# or: RAKAZO_BACKUP_AGE_RECIPIENTS_FILE=/etc/rakazo/backup-recipients.txt
```

With recipients set, each snapshot holds `rakazo.dump.age`, `appdata.tgz.age`, `SOURCE_SIZE_KB`,
and `SHA256SUMS`. `pg_dump` and `tar` stream straight into age, so plaintext never touches disk.
Verification needs no private key: `pg_restore --list` and `tar -t` read the same plaintext stream
while it is encrypted, each file must carry an age header, and the checksums cover the encrypted
files.

Without recipients the backup stays plaintext as before, logs a warning, and the host check alerts
that the latest backup is not encrypted. After the first encrypted backup, a run without recipients
fails instead of quietly writing plaintext. Set `RAKAZO_BACKUP_ALLOW_PLAINTEXT=1` only to accept
plaintext on purpose; it also silences the host-check alert.

For an off-site copy, install `rclone` and set `RAKAZO_BACKUP_OFFSITE_REMOTE` to any
[rclone remote](https://rclone.org/overview/) and path, such as an S3-compatible bucket or an SFTP
server. Configure the remote with rclone's own settings in the same file, for example:

```env
RAKAZO_BACKUP_OFFSITE_REMOTE=offsite:rakazo-backups
RAKAZO_BACKUP_OFFSITE_KEEP=14
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=replace-me
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=replace-me
```

After each verified local snapshot, the encrypted files are uploaded to `<remote>/<stamp>/`,
checked with `rclone check`, and only then given `SHA256SUMS`, which marks the copy complete. Off-site copies require encryption. The remote
keeps the newest `RAKAZO_BACKUP_OFFSITE_KEEP` complete snapshots (default `14`), independent of
`RAKAZO_BACKUP_KEEP`; only stamp-named directories are removed. Set it to `0` to leave deletion to
the bucket's lifecycle rules, so the credentials need list, read and write but no delete permission. A failed upload keeps the
local snapshot but fails the service, so the backup alert fires.

#### Restoring an encrypted backup

Run these where the identity file lives, never leaving it on the server. Fetch a snapshot with
`rclone copy offsite:rakazo-backups/<stamp> ./<stamp>` or `scp`, then run the drill, which checks the
checksums and decrypts each file into `pg_restore --list` and `tar -t` without writing plaintext
(it needs `age`, `pg_restore` of the server's major version or newer, which is 18 for the
production Compose file, and `tar`):

```bash
bash infra/compose/backup-drill.sh ./<stamp> rakazo-backup.key
```

**Never extract appdata over the active volume.** Files created after the snapshot would survive
and mix with the restored database. Extract into a clean sibling directory, then preserve the
old tree before replacing it. Pause automatic deploys and the updater during recovery. Stop
any other processes that write to this database or volume. Keep the application stopped if
any step fails.

Run these commands in one Bash session on the machine with the identity file. Replace the
snapshot and volume names first. `VOLUME` must name the volume the API currently mounts at
`/data`, which can differ when the stack uses another project name.

```bash
set -euo pipefail
umask 077
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
VOLUME=rakazo-prod_appdata

ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web"
ROLLBACK_DUMP="$(mktemp "$PWD/before-restore.dump.XXXXXX")"
if ! ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_dump -Fc -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'" \
  > "$ROLLBACK_DUMP"; then
  printf 'Pre-restore dump failed. Do not use the partial file at %s. Keep the application stopped.\n' "$ROLLBACK_DUMP" >&2
  exit 1
fi

APPDATA="$(ssh deploy@app.example.com "sudo docker volume inspect -f '{{.Mountpoint}}' '$VOLUME'")"
RESTORE="$(ssh deploy@app.example.com "sudo mktemp -d '${APPDATA%/*}/rakazo-restore.XXXXXX'")"
ssh deploy@app.example.com "sudo mkdir '$RESTORE/staged'"
printf 'Record this rollback pair:\nDatabase dump: %s\nData tree on deploy@app.example.com: %s/previous\n' \
  "$ROLLBACK_DUMP" "$RESTORE"
age -d -i rakazo-backup.key <stamp>/appdata.tgz.age | ssh deploy@app.example.com \
  "sudo tar -xzf - --numeric-owner -C '$RESTORE/staged'"

age -d -i rakazo-backup.key <stamp>/rakazo.dump.age | ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"

ssh deploy@app.example.com \
  "sudo mv -- '$APPDATA' '$RESTORE/previous' && sudo mv -- '$RESTORE/staged' '$APPDATA'"
ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE up -d --force-recreate --wait --pull never api worker web"
```

The archive must extract successfully before the SQL import starts. The clean staging directory
and the rollback tree sit beside the volume's active data directory, on the same filesystem.
Recreating the application containers makes them mount the replacement directory.
`--single-transaction` rolls back SQL errors, but it cannot include the directory switch.
After the import commits, a failed switch or startup can leave the database and active tree
out of sync. If startup fails, stop `api worker web` again, including containers that did start.

`$ROLLBACK_DUMP` names a private, plaintext rollback dump. `mktemp` creates a new mode-`0600`
file for each attempt without overwriting `before-restore.dump`, earlier rollback dumps, or
existing symlink targets. If the dump fails, the commands stop with the application still
stopped. The printed partial file is not usable rollback data. Preserve earlier rollback pairs
and fix the dump failure before starting another recovery attempt.

Record the printed database dump path together with its matching remote `$RESTORE/previous`
tree path. Keep that pair until you have checked the restored application. Do not remove the
Docker volume while you need the rollback tree. For rollback after SQL commits, keep the
application stopped and restore the recorded `$ROLLBACK_DUMP` into a freshly created empty
database. Move the failed active tree to a separate path for diagnosis, then move that attempt's
recorded `$RESTORE/previous` tree back to `$APPDATA` and recreate the application containers.
If the first directory move failed, the old tree is still at `$APPDATA`. Inspect both paths
before moving anything. Switching the tree alone does not roll back the database.

Plaintext snapshots use `cat` in place of `age -d` and the filenames `rakazo.dump` and
`appdata.tgz`. Use the same clean-directory procedure.

To restore into a new stack, create the `rakazo_app` role before the procedure above. The dump
grants to it, and on a new stack only the migration step would create it, so `pg_restore`
stops without it. Do not run the migrations first: tables newer than the snapshot would block
the restore. The procedure's final start applies them.

```bash
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait postgres"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE\"'"
```

The scheduled backup uses `/srv/rakazo` by default. For another deployment directory, set
`RAKAZO_DEPLOY_DIR=/absolute/path/to/checkout` in a root-owned `/etc/rakazo/backup.env`
(mode `0600`). The service reads this optional file on each run; the script uses the selected
checkout's `.env` and production Compose file. If the stack was started with a custom `-p`,
set the same `COMPOSE_PROJECT_NAME` in that file. Set the retention and space settings there too.
When updating an existing installation, reinstall the script and units, then run
`systemctl daemon-reload`; pulling the repository does not update `/usr/local/sbin` copies.

For a dedicated backup disk, mount it persistently and bind its `backups` directory onto
`/var/backups` in `/etc/fstab`. Add `x-systemd.requires-mounts-for=/mnt/your-backup-volume` to the bind
mount options. Set `RAKAZO_BACKUP_REQUIRE_VOLUME=1` and add a service drop-in containing
`RequiresMountsFor=/var/backups` and `AssertPathIsMountPoint=/var/backups` under `[Unit]`. The script
then refuses to fall back to root storage if the mount is missing or points at the root filesystem.

Monitoring is opt-in. Install `host-alert.py` as `/usr/local/sbin/rakazo-host-alert` and
`check-host.sh` as `/usr/local/sbin/rakazo-host-check`, and `check-services.py` as
`/usr/local/sbin/rakazo-check-services` (all executable), then install the supplied host-check service
and timer and enable `rakazo-host-check.timer`. Checks run every five minutes and report low disk
space, failed backups, a verified backup older than 36 hours, or missing configured IPv4 SSH rules.
To also check API and worker containers, set `RAKAZO_MONITOR_COMPOSE_PROJECT` in `backup.env` to
the Compose project name (`rakazo-prod` for production). The worker probe checks heartbeat and
reconciliation freshness. Leave the variable unset if container monitoring is managed elsewhere.

The dedicated-volume check is enabled only by `RAKAZO_BACKUP_REQUIRE_VOLUME=1` in `backup.env`.
Identical alerts are suppressed for a day; recovery sends a separate notification.

Alerts go to the system journal by default; no external service is required. For optional Slack
delivery, create a root-only `/etc/rakazo/alerts.json` containing
`{"slack_webhook":"https://hooks.slack.com/services/REPLACE/ME/SECRET"}`. Never commit this file.
To notify immediately on backup failure, also install `rakazo-backup-alert.service` and copy
`infra/systemd/rakazo-backup-alerts.conf.example` to
`/etc/systemd/system/rakazo-backup.service.d/alerts.conf`. Run `systemctl daemon-reload` after
installing units or drop-ins. The base backup service does not require the monitoring tools.

Host hardening preserves existing firewall rules and installs `firewall-change.sh` as
`/usr/local/sbin/rakazo-firewall-change`. For subsequent firewall edits, use
`sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change apply COMMAND...`.
This requires `SSH_CONNECTION` to be preserved, saves both `/etc/ufw` and `/etc/default/ufw`,
and arms a three-minute rollback before running the command.
Open a **new SSH connection** and run the printed `confirm TOKEN` command; confirmation from the
original connection is rejected. An unconfirmed change restores the saved rules and default policies.
The guard does not protect arbitrary direct `ufw` commands or SSH daemon configuration changes.

To deploy from CI, install `infra/compose/deploy-launcher.sh` as `/usr/local/sbin/rakazo-deploy-main`
and give CI a key restricted to it in the deploy user's `authorized_keys`
(`restrict,command="/usr/local/sbin/rakazo-deploy-main" ssh-ed25519 …`). CI deploys a main commit
only after its checks pass and `ci.yml` has published its images, so the host pulls
`<RAKAZO_DEPLOY_IMAGE>:sha-<commit>` instead of building next to live traffic.
`RAKAZO_DEPLOY_IMAGE` defaults to `ghcr.io/<owner>/<repo>/app` for the GitHub repository the
checkout tracks, so a fork pulls what its own CI published. If the pull fails or takes longer than
`RAKAZO_DEPLOY_PULL_TIMEOUT` (default `5m`), the deploy logs a warning and builds the checkout on
the host instead; set `RAKAZO_DEPLOY_IMAGE=` (empty) to always build. This repository's images are public, so the
host needs no registry login; for a private fork package, `docker login ghcr.io` as root with a
token that can only read packages. The deploy
starts each new API, web and worker container beside the running one and stops the old one only
once the new one is healthy, so a deploy does not take the site offline or pause chat, then waits for
`https://$RAKAZO_HOST/health` and rolls back on failure by restoring the image the previous
containers ran. Old and new API containers serve together
for a few seconds after migrations run, so a migration must keep working with the previous
release: add first, and drop or rename only in a later deploy. Pull, build and
start are time-limited so a stuck step fails the deploy instead of holding its lock; a deploy that
finds the lock held exits non-zero. A deploy refuses to start with less than
`RAKAZO_DEPLOY_MIN_FREE_GB` (default `5`) free, and after a healthy rollout it keeps the current and
previous app images (the previous ones tagged `rakazo-rollback`), removes untagged images, and
trims the build cache that fallback builds leave to `RAKAZO_DEPLOY_BUILD_CACHE_GB` (8 GB by default).
For a checkout outside `/srv/rakazo`, put `RAKAZO_DEPLOY_DIR=/absolute/path` (and any of these
settings) in a root-owned `/etc/rakazo/deploy.env` readable by the deploy user. The launcher runs
`infra/compose/deploy-main.sh` from `origin/main`, so deploy changes apply on the next deploy; only
a change to the launcher itself needs
`sudo install -m 0755 infra/compose/deploy-launcher.sh /usr/local/sbin/rakazo-deploy-main`.

#### Point-in-time recovery

The nightly backup can lose up to a day. Point-in-time recovery streams the database's write-ahead
log (WAL) to S3-compatible object storage and takes a base backup every 24 hours, so the database
can be restored to any moment in the last `PITR_RETAIN_DAYS` (default `7`) and a lost server costs
about a minute of writes. It covers the database only; keep the nightly backup for application
data. It is off by default and needs the production Compose file with Postgres 18.

The optional `pitr` service streams WAL with `pg_receivewal` over the internal `data` network,
using a replication-only login and a replication slot, and uploads from its own network, so
Postgres keeps no internet access. Postgres closes a WAL segment at least every minute while
anything is written (`archive_timeout`). Each segment and base backup is encrypted with
[age](https://age-encryption.org) to public recipients before it leaves the container, as the
nightly backup is, so the server cannot read its own backups. You can use the same recipients.

The slot keeps WAL that has not reached the sidecar, so a sidecar restart leaves no gap. Disk use
stays bounded if uploads stall: the sidecar holds at most `PITR_MAX_WAL_GB` (default `4`) of
compressed WAL waiting to upload, then pauses streaming, and Postgres keeps at most that much again
for the slot (`max_slot_wal_keep_size`). Beyond that Postgres drops the slot's WAL, recovery has a
gap, and the sidecar takes a new base backup once it reconnects.

Use a bucket of its own. Its credentials need to list, read, write and delete objects in it;
deletes only remove backups older than the retention window. With `PITR_RETAIN_DAYS=0` nothing is
deleted, so no delete permission is needed and the bucket's lifecycle rules handle expiry. Add to
`.env`:

```env
COMPOSE_PROFILES=pitr
PITR_DATABASE_PASSWORD=replace-with-openssl-rand-hex-24
PITR_BUCKET=example-rakazo-pitr
PITR_ENDPOINT=https://s3.example.com
PITR_REGION=example-region
PITR_ACCESS_KEY_ID=replace-me
PITR_SECRET_ACCESS_KEY=replace-me
PITR_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# Optional: PITR_PREFIX (a key prefix), PITR_PATH_STYLE=true (path-style bucket addressing),
# PITR_RETAIN_DAYS, PITR_MAX_WAL_GB.
```

`COMPOSE_PROFILES` is comma-separated; with the updater it is `updater,pitr`. Leave `PITR_ENDPOINT`
unset for AWS S3. Then turn it on from the checkout:

```bash
sudo infra/compose/pitr.sh enable
```

This creates the `rakazo_pitr` replication login, allows it in `pg_hba.conf`, sets
`archive_timeout` and `max_slot_wal_keep_size`, and reloads Postgres without restarting it. The
sidecar then takes its first base backup. Run `enable` again after changing `PITR_DATABASE_PASSWORD`
or `PITR_MAX_WAL_GB`, or after moving Postgres to a new cluster. Uploads are grouped by the
cluster's system identifier, so a new cluster never overwrites an old one's WAL.

The sidecar's health check fails when an upload has waited over ten minutes, streaming is paused,
nothing is streaming from the slot, or the last base backup is over 30 hours old. With
`RAKAZO_MONITOR_COMPOSE_PROJECT` set, the host check alerts on it. For details:

```bash
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec pitr rakazo-pitr health
```

Restores run on any machine with Docker and this checkout. The identity comes on stdin and stays in
memory inside the restore container. Prove the latest point restores, into a scratch volume that is
removed afterwards. Run it after enabling, after changing the PITR scripts, and periodically:

```bash
sudo infra/compose/pitr.sh drill < rakazo-backup.key
```

Away from the server, set `PITR_ENV_FILE` to a file holding only the `PITR_` storage settings. To
recover production to a moment, stop everything that writes to the database and restore into its
volume. The current cluster is moved aside inside the volume, not deleted. The time is read as UTC
unless it names a zone:

```bash
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web pitr postgres"
ssh deploy@app.example.com \
  "cd /srv/rakazo && sudo infra/compose/pitr.sh restore '2026-01-31 09:41:00+00' rakazo-prod_postgres" \
  < rakazo-backup.key
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait"
```

The restore uses the newest base backup that finished before the target, replays WAL up to it, and
promotes the result, which starts a new timeline; the sidecar takes a fresh base backup for it. Pause
CI deploys during recovery. Once the restored database checks out, remove the old cluster:
`$COMPOSE run --rm --no-deps --entrypoint sh postgres -c 'rm -rf "$PGDATA".before-restore-*'`.

To turn it off, remove `pitr` from `COMPOSE_PROFILES`, then run `sudo infra/compose/pitr.sh disable`.
It removes the sidecar, the slot (so Postgres stops keeping WAL for it), the login and the
settings. Uploaded backups stay in the bucket.

#### Host audit trail

`harden-host.sh` installs audit rules for writes to SSH keys, sudoers, accounts, `/etc/rakazo`, the
deployment's `.env`, `/usr/local/sbin`, systemd units, cron, and the Docker daemon config. A rule
whose directory does not exist yet, such as the `.env` before the first clone, is skipped with a
notice; rerun the script once it exists. Anyone with root can wipe local logs, so the record only
helps once it has left the host.

To ship it, create a root-only `/etc/rakazo/audit-ship.env` and put the sink's token in
`/etc/rakazo/audit-ship.token`, then rerun `harden-host.sh`. Only then does it install `audit-ship.py`
as `/usr/local/sbin/rakazo-audit-ship` and enable `rakazo-audit-ship.service`. The sink is any HTTPS
endpoint that accepts a JSON array of events with a bearer token, for example Axiom's
`https://api.axiom.co/v1/datasets/<dataset>/ingest`.

```env
RAKAZO_AUDIT_SINK_URL=https://ingest.example.com/v1/events
# Optional: name the SSH keys you expect (fingerprints from `ssh-keygen -lf key.pub`).
RAKAZO_AUDIT_KNOWN_KEYS=SHA256:replace-with-fingerprint=laptop SHA256:replace-with-fingerprint=ci
# Optional: RAKAZO_AUDIT_TOKEN_FILE (default /etc/rakazo/audit-ship.token), RAKAZO_AUDIT_HOST
# (default: the hostname), and RAKAZO_AUDIT_HEARTBEAT_SECONDS (default 10800, three hours).
```

Use a token that can only write to that one destination, so a compromised host cannot read or delete
what it already sent. The shipper follows `/var/log/auth.log` and the audit log and sends `ssh.login`
(with `key_name`, `unknown` for keys not listed), `ssh.failed`, `sudo.command`, `su`,
`identity.change`, and `file.change` (with the rule's `watch` key and the changed `paths`), plus a
`shipper.heartbeat` on start and every `RAKAZO_AUDIT_HEARTBEAT_SECONDS`. Every
event carries `event`, `host`, `source`, `message`, and `_time`. Offsets advance only after the sink
accepts a batch, and failures retry with backoff, so events arrive at least once. On first start it
ships the current auth log and starts the audit log at its end. With monitoring installed, the host
check alerts when a sink is configured but the shipper is not running.

Alert in the destination, not on the host. Starting points, written as Axiom APL here but plain
filters in any log store:

| Alert | Query |
| --- | --- |
| Login with an unnamed key | `where event == "ssh.login" and key_name == "unknown"` |
| Watched file changed | `where event == "file.change"` outside your own deploys and maintenance |
| Root use outside the deploy account | `where (event == "sudo.command" and user != "deploy") or event == "su" or event == "identity.change"` |
| Shipping stopped | no `shipper.heartbeat` from a `host` for more than two heartbeat intervals |

### Docker computers on the production stack

Layer `infra/compose/docker-compose.prod.docker.yml` after the base file in every Compose
invocation to run bot computers as local Docker containers instead of a remote provider:

```bash
# Pull only the pull-only dependency images (postgres, caddy, busybox);
# --pull never fails when they are absent locally.
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  pull --ignore-buildable
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  up -d --build --wait --wait-timeout 300 --pull never
```

In this topology `api`, `worker`, `web`, `supervisor`, and `computer` always build
from the checkout — `pull --ignore-buildable` only covers dependencies that have no
`build` section. To deploy published app images instead of building, use the base
file without the overlay. If `docker compose up --help` lacks `--wait-timeout`
(older Compose), drop `--wait` and verify with `docker compose ... ps` instead;
`--wait` alone can hang on one-shot services.

The overlay adds the supervisor (app image, `user: root`, Docker socket), the one-shot `computer`
image build and `data-init` ownership fix, points the API and worker at `http://supervisor:7091`,
and makes `SANDBOX_PROVIDER=docker` the default. It needs a dedicated `SANDBOX_SUPERVISOR_TOKEN`
in `.env`; `RAKAZO_COMPUTER_*` and the `SANDBOX_*` limits apply as documented in `.env.example`.
Like the updater, the supervisor is root-equivalent on the host: it publishes no port, joins only
the internal `app` network, and Caddy has no route to it. Bot computers are sibling containers on
per-bot networks that only the supervisor and the `web` screen proxy join.

When the `updater` profile is enabled too, give the sidecar the same file list and recreate set so
updates do not leave the supervisor on the previous app image:

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.prod.docker.yml
RAKAZO_UPDATE_SERVICES=supervisor
```

The updater pulls and recreates services but cannot rebuild the `computer` stub image
(`pull_policy: build` is not pullable). Rebuild it on the host when the computer image
should change — for example after updating the checkout:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  build computer
```

## Restore

For backups created by `scripts/backup.sh`, use an empty `rakazo` database in the development
Compose stack. The script validates and extracts the homes archive in a clean sibling directory
before touching the database, then stops the API, worker, and supervisor. It rejects a `data/`
path that is a symlink or a non-directory. Stop bot computers and any other processes that
write to this database or tree before running the script.

The SQL import runs in one transaction and stops on the first error, including conflicts with
existing tables. An invalid archive or failed import leaves the current data tree unchanged.
After SQL succeeds, the script moves the current tree to `data.rollback.<random>/data`,
prints that path, and replaces `data/` with the saved tree. Files absent from the snapshot
do not remain in the active tree. A missing homes archive or an empty archive from omitted homes
leaves `data/` unchanged. An archive containing an empty `data/` directory replaces it with an
empty tree.

Application services start only after the import and tree replacement succeed. Once writer
shutdown starts, a later failure or interruption makes the script attempt to stop the API,
worker, and supervisor again. This includes services that started before final startup failed.
The script preserves the original failure status even if cleanup fails. If Docker cannot stop
the services, stop them before recovery.

A failure after the SQL commit cannot roll back the database automatically. Leave the
application stopped, preserve both trees, and recover a matching database before moving the
rollback tree back to `data/`. Keep a separate database backup from before recovery if you
need that rollback. This script does not consume the production snapshot's custom-format
`rakazo.dump` or `appdata.tgz`.

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

A Compose deployment on a published release tag upgrades by moving that tag:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

A deployment on the default `local` tag has no registry to pull from, so it upgrades by rebuilding
the checkout instead:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. The API starts only after the `migrate` container finishes, so a migration failure keeps the new API
from starting. A failed CLI recreate does not auto-roll back; recover with the previous
`RAKAZO_IMAGE_TAG` (or rebuild `local`) and `up -d --wait --pull never`.

The updater sidecar has its own image and tag so an update never recreates the process performing
it. Move it deliberately by setting `RAKAZO_UPDATER_IMAGE_TAG` to the full `sha-<commit>` tag, then
running `docker compose … pull updater && docker compose … up -d --wait --pull never updater`.
Sidecar `/apply` and `/rollback` recover a failed recreate by redeploying the previously cached
image when possible; if that also fails, they report a possible mixed-version runtime.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm db:migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Upgrading to the separate app database login

Releases with [database roles](#database-roles) need `POSTGRES_APP_PASSWORD` in `.env`. The
desktop app, `install-images.sh`, the updater sidecar and `infra/compose/deploy-main.sh` add it
when it is missing.
Elsewhere, add it yourself (`openssl rand -hex 16`) before you pull, or Compose stops at config
validation with `Set POSTGRES_APP_PASSWORD in .env`. On first start, the API creates the
`rakazo_app` login, and the API and worker then connect as it. Nothing else changes, and the
upgrade does not rewrite any data.

If a feature misbehaves under row-level security, run `ALTER ROLE <login> BYPASSRLS;` on the login
in `DATABASE_URL` (`rakazo_app` in Compose) as a superuser (the Compose owner is one), then
restart the API and worker. Role attributes are not inherited, so granting it to `rakazo_app` does
nothing for a separate login. The app then runs as before, with a startup warning, and later
migrations leave that login alone. Undo it with
`NOBYPASSRLS` and another restart, then search the API and worker logs for
`violates row-level security` and `without a tenant or system context`. An older release ignores
the extra variable and connects as the owner, but releases from the same day also encrypt content
at rest: run `content-encryption decrypt` before rolling back past them
([content encryption](./content-encryption.md#rollout)), or older releases show ciphertext.

### Upgrading to Postgres 18

The production and source-checkout Compose files run Postgres 18. Installs created before that
keep their data in a Postgres 16 volume (`pgdata`), which Postgres 18 cannot open. Until the data
is copied to the new `postgres` volume, the database container exits and logs that it found
PostgreSQL data in `/var/lib/postgresql/16/docker`, and production deploys stop before replacing
anything. Nothing is deleted or started empty. New installs need nothing. The published-images
file (`docker-compose.images.yml`, also used by the desktop app) stays on Postgres 16.

Take a backup and run the drill on it first ([encrypted backups](#encrypted-and-off-site-backups)).
Then update the checkout and run the upgrade as root:

```bash
cd /srv/rakazo
git pull --ff-only
sudo infra/compose/upgrade-postgres.sh
```

When the stack uses other Compose files, such as the Docker computers overlay or the
source-checkout stack, pass all of them:
`sudo RAKAZO_DEPLOY_DIR="$PWD" infra/compose/upgrade-postgres.sh infra/compose/docker-compose.yml`.
Set `COMPOSE_PROJECT_NAME` if the stack runs under a custom `-p`, and on restricted networks set
`RAKAZO_POSTGRES_16_IMAGE` to your mirror of the previous Postgres 16 image (`POSTGRES_IMAGE` must
now name a Postgres 18 image).

The script stops the stack, copies every role (with its password) and database from Postgres 16
with `pg_dumpall`, and compares roles, memberships, ownership, grants, row-level security
policies, sequences and the row count of every table. It also checks that `rakazo_app` signs in
with `POSTGRES_APP_PASSWORD` and does not bypass row-level security. Only then does it switch
Postgres 18 over and restart the services that were running. The site is down for the whole copy,
which takes about as long as dumping and restoring the database: a few minutes for a small one. It needs free disk for one more copy of the
database plus 1 GiB. Running it again after it succeeded does nothing. If any step fails, it stops
with the stack down and the Postgres 16 data unchanged; fix the error and run it again. On the
production host, then rerun the deploy that stopped.

The Postgres 16 volume stays as it was, mounted read-only. To roll back, check out the previous
release and start the stack: it runs Postgres 16 on the original data. Anything written after the
upgrade exists only on Postgres 18, so roll back right away or not at all, and pause CI deploys
until you upgrade again. Once you no longer need the rollback, stop `postgres`, remove the
`<project>_pgdata` volume and start it again; Compose recreates that volume empty.

### Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

### Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/elie222/rakazo/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop used as each bot computer |
| `ghcr.io/elie222/rakazo/updater` | the updater sidecar, plus the Docker CLI |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port). Production Compose (`docker-compose.prod.yml`) can
also pull the same app tags once `RAKAZO_IMAGE_TAG` is set to a published value.

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<full-commit>` | nothing — built on the server by a fork update | never |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every main commit, release tag and manual run | source-addressed; used by the updater sidecar |
| `edge` | pushes to main | yes, to the newest main build |

Every publish, including `edge` from main merges, is multi-arch (`amd64` + `arm64`): each
architecture builds natively, on Depot when the `DEPOT_PROJECT_ID` repository variable names a
project and on GitHub's runners otherwise, and one manifest is assembled per image. Depot builds
publish and attest each image in the same job; native GitHub builds combine their architecture
artifacts in a separate publication job. Main CI revisions validate independently. Publication
locks are per image, and a superseded main build keeps its commit tag without moving `edge`.
Image and release queues retain pending jobs so a slower older run cannot displace a newer one.
Production deployment remains serialized and deploys the exact revision that passed its checks.
Before any tag points at a new app image, CI fails the publish if it holds a `.env` file, a `.git` directory or a
private key (`infra/compose/check-image.sh`). Until a
stable `vX.Y.Z` has been published, GHCR may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

Building the images yourself does not need QEMU. `docker compose up --build` builds for the host's
own architecture, and a fork publishing multi-arch images should do what `publish-server-image.yml`
does: build each architecture on a native runner (GitHub Actions provides `ubuntu-24.04-arm` for
public repositories) and merge the digests into one manifest. QEMU emulation
(`docker/setup-qemu-action`, `binfmt`) still works if you have no native arm64 machine, but it is
many times slower, hours rather than minutes for the `computer` image.

The updater resolves the newest stable `vX.Y.Z` source tag but deploys its `sha-<full-commit>` image,
not `latest` or a moving minor tag. A registry tag is not an OCI digest and GHCR package writers can
replace it, so the trust boundary remains this repository's publishing credentials. The workflow
reduces that boundary by using SHA-pinned actions, read-only pull-request jobs, digest-pinned base
images, SBOM/provenance output, and a GitHub build attestation. Operators who require registry-level
content addressing can pin `RAKAZO_IMAGE` outside the automatic updater to a verified digest.

Rollback never contacts the registry: it redeploys the previous tag from the local Docker cache,
so a later tag move cannot change rollback content. Do not prune the previous application image
until the next update has been accepted. If it is missing, rollback fails closed instead of pulling
new content under an old tag.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags. The updater ignores prereleases
and refuses the official path until a stable `vX.Y.Z` exists.

### Updater sidecar

Compose production deployments offer an opt-in `updater` profile on a private `control` network.
Normal deployments do not start it or require its credential. To enable it, set a dedicated
`RAKAZO_UPDATER_TOKEN` and explicitly start the profile:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

It exposes `/health`, `/state`, `/plan`, `/apply`, and `/rollback` at `http://updater:7092` with
`RAKAZO_UPDATER_TOKEN`. Operator CLI upgrades above do not need it; the sidecar is for automated
apply/rollback over that private HTTP API. Only deployment tooling calls it; app accounts have no update endpoint, and the application API does not receive the updater token.

The API cannot update itself — its image has no `.git`, and nothing inside the container would
restart it — so the work happens in a separate `updater` container that outlives the recreate:

- *Official repository:* resolves the newest stable release and its source commit with
  `git ls-remote --tags`, pins the corresponding full `sha-<commit>` image tag in `.env`, keeps the
  outgoing tag in `RAKAZO_IMAGE_TAG_PREVIOUS`, explicitly pulls the new image, then runs
  `up -d --wait --pull never`. No build runs on the server.
- *Fork (Advanced):* a fork has no published images, so the sidecar fast-forwards the checkout in
  `RAKAZO_DEPLOY_DIR` and runs `up -d --build`. This builds on the server and takes minutes rather
  than seconds. Point it only at a fork you control and have reviewed — the sidecar runs that
  Compose file through a root-equivalent Docker socket.

Updates and rollbacks run one at a time. A failed pull leaves running services alone; a failed recreate restores the previous environment
pin and attempts to redeploy the cached previous image. A failed fork build also restores the
pre-update branch and commit (including when checkout succeeded but merge did not) so a later
manual `--build` cannot deploy the rejected or unintended revision. Database migrations are not
reversed. The sidecar never recreates itself, never touches Postgres or Caddy, and never runs
migrations — that ordering belongs to the API's dependency on the `migrate` service.

Only `https://` and `ssh://` git remotes are accepted. Merges are fast-forward only. A dirty or
untracked source tree fails closed before anything runs (the application Dockerfile uses `COPY . .`).

### The deploy directory must be one path

`RAKAZO_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`), and that is load-bearing rather than tidy. Production
Compose defaults both sides to `/srv/rakazo`; set the variable for any other layout. When the
updater runs `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. Compose makes the effective `-p` value available for interpolation but does
not automatically put it in a container's environment, so the production file explicitly assigns
`COMPOSE_PROJECT_NAME` to the updater. A standalone sidecar can instead set
`RAKAZO_COMPOSE_PROJECT_NAME`; the final fallback is `rakazo-prod`. Without that propagation, a
stack started with `-p something-else` would be left alone while a second project with a new empty
Postgres volume came up beside it.

### Deployments that layer a Compose overlay

`RAKAZO_COMPOSE_FILE` takes a list, separated the way Compose's own `COMPOSE_FILE` is
(`:` by default, or whatever `COMPOSE_PATH_SEPARATOR` says). Each entry becomes its own `--file`,
in the order given, so the updater reconciles the same stack the operator runs by hand:

```
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

Every entry is validated separately and must stay inside `RAKAZO_DEPLOY_DIR`.

If the overlay adds a service built from the application image, name it in
`RAKAZO_UPDATE_SERVICES` (comma separated) so it is pulled, recreated and rolled back with the
rest. Otherwise an update leaves that service running the previous code:

```
RAKAZO_UPDATE_SERVICES=supervisor
```

These names are appended to the built-in `api`, `worker`, `web`, never substituted for them, so no
value here can drop a core service from an update.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `/srv/rakazo` is the default and supported production layout. Set `RAKAZO_DEPLOY_DIR` explicitly
  when the checkout is elsewhere.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\rakazo` is
  `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

### The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the dedicated `control` network shared with the API. Caddy is not attached, so the
  reverse proxy has no route to the updater.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The process environment carries only updater settings (`RAKAZO_UPDATER_TOKEN`, deploy path,
  image name, project name). Application secrets stay in the bind-mounted `.env` that Compose
  reads for interpolation; they are not loaded into this container.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Enabling the `updater` profile requires `RAKAZO_UPDATER_TOKEN` to be a dedicated random value (at
least 32 characters in production). It must differ from `BETTER_AUTH_SECRET`,
`SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`. Leave the profile disabled if you would
rather not grant the capability.

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 or newer and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. Homes stay on that volume unless they are kept in
[object storage](#bot-homes-in-object-storage); other `DATA_DIR` files still need it shared.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](#choosing-a-computer-provider) appropriate to the
service's trust boundary. `SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` apply from the environment on every API start.
The optional marketing site in `apps/www` can be hosted separately.

## Image and video generation

Bot media tools are disabled by default. Configure the worker (and API for inline
execution) with a provider and its generic HTTP connection:

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

`MEDIA_GENERATION_PROVIDER` accepts `disabled` (the default), `fal`, or `fake`
(for offline testing only). The base URL is optional and defaults to the URL above.
Only set the image/video model fields for capabilities you want enabled. Compatible
servers can use the same connection fields; models must support the corresponding
fal queue API and Flux/Wan input and output shapes. Credentials stay on the server. Set these in
your deployment secret configuration; never commit actual credentials.

Bots use `generate_image` to attach one PNG or `generate_video` to submit a
four-second MP4. The video tool returns a job ID and queued/running status; call it
again with `jobId` to check progress and attach the completed video. Saved jobs
can be polled after worker restarts by the same owner/bot/thread. The first version
requires polling through the bot; it does not automatically deliver jobs in the
background. Use the existing per-bot tool switches and action approval rules to
control access. Both tools require approval by default. Ticket board runs keep
these chat-only media tools unavailable so ticket work stays on the board.

Each run allows at most two submissions (including failures). Submissions are
never retried automatically: a lost response can mean the provider accepted and
charged for the request. Provider errors omit remote response bodies. Configure
account budgets and rate limits with your provider; the run cap is not a currency
budget. Provider 429 responses are returned without automatic retries. Outputs
must fit both the 10 MiB media ceiling and the configured attachment limit;
larger outputs are rejected.

Images use existing inline chat rendering. MP4 files can be previewed with native
video controls on web and Electron and opened/downloaded through the existing
native file flow on mobile. No new mobile player or settings screen is required.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.

Plain `http://` is accepted only for a private IP, `localhost`, or a `.local` name. A hostname reached over a VPN such as WireGuard or Tailscale needs HTTPS with a certificate the phone trusts, for example a real domain with a Let's Encrypt certificate issued through a DNS challenge.

### Passkeys

Passkeys are on whenever `WEB_ORIGIN` is an HTTPS domain (or `localhost` in development); the
relying party is that origin's host, so existing passkeys keep working only while `WEB_ORIGIN`
stays on the same domain. They are off when password sign-in is disabled for SSO-only
deployments. On web, a browser offers them where it has a platform authenticator. The macOS
desktop app uses the system passkey sheet, which only serves the domain the release is
associated with (`app.rakazo.com`), so it hides passkeys for other servers.

Native apps can use a domain's passkeys only when the domain vouches for them and the app was
built for that domain (the app's associated domain comes from `EXPO_PUBLIC_API_URL` at build
time). To let a build use this server's passkeys, set:

```bash
# iOS and the macOS desktop app (dev.rakazo.desktop): <Apple Team ID>.<bundle id>, comma-separated.
# Served as /.well-known/apple-app-site-association.
PASSKEY_APPLE_APP_IDS=ABCDE12345.com.rakazo.app,ABCDE12345.dev.rakazo.desktop
# Android: SHA-256 fingerprints of the app signing certificates, comma-separated.
# Served as /.well-known/assetlinks.json and accepted as passkey origins.
PASSKEY_ANDROID_CERT_SHA256=AA:BB:...:FF
```

Until a platform's setting is set, the native app on that platform hides passkeys for this
server. Both files are served through the web origin, so a reverse proxy in front of the web container
must pass `/.well-known/` through to it.

## macOS voices

When the API runs on macOS, Voice settings also offers **macOS**, which needs no key. The API renders each reply with the built-in `/usr/bin/say` into an audio clip, so it plays on the listener's device and stops like any other voice. Docker and Linux hosts do not list it.

## Spoken summaries

Off by default. Set `VOICE_SUMMARY_MIN_CHARS` (for example `600`) to have a voice read a bot reply longer than that many characters as a short summary written by that bot's own model. Each summary is an extra model call billed to the bot. The chat keeps the full reply, and if the summary call fails the full reply is read.

## Upload size

`MAX_UPLOAD_SIZE_MB` sets the per-file chat attachment and computer file transfer limit
in MiB (1 MiB = 1,048,576 bytes). It defaults to `10` and must be a positive integer.
Set it in `.env` and restart the API, worker, and Docker supervisor (when used). Web, desktop, and mobile use the
limit advertised by the server. If a reverse proxy limits request bodies, allow
room for base64 encoding (about 4/3 of the file size) and the JSON envelope.

`MAX_ATTACHMENTS_PER_MESSAGE` sets the chat attachment count per message. It defaults
to `4` and accepts integers from `1` to `100`. Set it in `.env` and restart the API.
Web, desktop, and mobile use the advertised count; older clients and clients connected
to older servers keep the default of four. Chat bridges retain their existing safe
platform limits, and model image budgets still apply.

## Shared storage migration

Push notification registrations now live in Postgres, encrypted with `ENCRYPTION_KEY`.
The same key must be configured on every API and worker replica. Registrations remain
bound to their authenticated session; deleting an account also deletes its registration.

With `OBJECT_STORAGE_BUCKET` configured, new artifact contents use the existing
S3-compatible connection alongside computer homes. Artifact contents are always encrypted
before upload using the space's content key and authenticated segments bound to the
artifact identity. This applies even with `CONTENT_ENCRYPTION=off`. Metadata and access
checks remain in Postgres; clients and sandboxes receive neither bucket credentials nor
public object URLs. Without object storage, artifacts continue using the local volume.

Existing artifact rows continue reading their local files until migrated. Before spreading
API or worker replicas across machines, migrate files from every original application
volume. Back up the database and volume first. Deploy the schema migration and the new
application version, then stop **all API and worker processes**, including old releases,
while running the following commands from a maintenance container with the original volume,
`DATABASE_URL`, `ENCRYPTION_KEY`, content master keys, and object storage configuration:

```sh
# Published image (run from /app/apps/api):
node dist/cli/shared-storage.js artifacts --dry-run
node dist/cli/shared-storage.js artifacts
node dist/cli/shared-storage.js push-tokens --dry-run
node dist/cli/shared-storage.js push-tokens

# Source checkout equivalents:
pnpm --filter @rakazo/api shared-storage artifacts
pnpm --filter @rakazo/api shared-storage push-tokens
```

The artifact migration uploads and decrypts each file to verify it before conditionally
updating its database storage key. It keeps the original local files and skips rows already
migrated, so interrupted runs can resume. A database failure after upload can leave an
unreferenced object; do not delete objects blindly after a failed migration. Keep local
originals until the migration is complete and verified. Files absent from the mounted volume
are counted as pending while migration continues for files present on that volume. Run the
command on each original volume, then run `artifacts --dry-run` again and require `pending: 0`
before starting independent replicas. Object-backed artifacts require
object storage to remain configured; old application versions cannot read their new keys.
The local content-encryption CLI operates on local artifacts only; object artifacts stay
encrypted and retain access through the key versions referenced in their headers.

The push import preserves registrations with a live session, skips missing/expired or
sessionless registrations, accounts already registered in Postgres, and devices owned by any
existing database registration. Import never hands a device back to an older account. It archives processed
files with a `.migrated` suffix. Those archives are never used as a runtime fallback, so they
cannot restore a registration after logout. Clients skipped during migration register again
when they next open the app. Remove the archived token files after verifying the import.
Restart API and worker processes after both commands finish. A schema-only rollback remains
compatible with the previous release, but the old code does not read database registrations
or object-backed artifacts.
