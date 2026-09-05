# Cadre cloud workforce

Cadre is a cloud deployment of Rakazo with managed computers and a Company OS workforce connection. The upstream local, desktop, mobile, and other provider paths remain available. Cloud configuration is optional.

## Deployment

- Vercel serves the web app. Set `API_PROXY_TARGET` to the HTTPS origin of the API service; `infra/vercel-build.mjs` generates same-origin API routing without baking account configuration into source.
- Render runs the API and job worker with PostgreSQL. `render.yaml` describes the resources. Apply migrations before starting the runtime. For a single service, `infra/render-start.mjs` supervises both processes.
- Modal runs one isolated Linux desktop per computer. Build with `uv run --with modal python infra/modal/build_image.py` and configure the returned image ID and Modal credentials on the runtime.
- Cloudflare hosts the screen gateway and R2 object store. Deploy `infra/cloudflare/wrangler.jsonc`, then set `SCREEN_PROXY_SECRET` and `STORAGE_GATEWAY_TOKEN` with Wrangler secrets. Set the same values on the runtime. Configure `SCREEN_GATEWAY_ORIGIN` and `R2_GATEWAY_URL` to the Worker origin and `STORAGE_PROVIDER=r2-gateway`.
- OpenRouter supplies the models. Users connect their key in Models; optional deployment credentials use `OPENROUTER_API_KEY`, `PI_DEFAULT_PROVIDER=openrouter`, and `PI_DEFAULT_MODEL`.

Set `WEB_ORIGIN` and `BETTER_AUTH_URL` to the web origin, `API_URL` to the runtime origin, and independent strong `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` values. Keep public signups disabled until the deployment is ready. An allowlist does not override `SIGNUPS_ENABLED=false`: bootstrap an owner through the auth/database services, or enable signups with a restricted `SIGNUP_ALLOWLIST` during initial registration and disable them afterward. Never commit values or generated deployment output.

## Company OS protocol

The Company OS MCP endpoint must expose `workforce_sync` protocol version 1. The Workforce dialog accepts a Company OS agent key with context read and write capabilities. The key determines the company and permitted departments. The model cannot invoke queue mutation or workforce methods through its MCP tool set; the dispatcher owns those transitions.

Every 15 seconds the worker advertises available capacity and reports run state. Company OS atomically claims eligible work and returns stable dispatch IDs. Cadre persists each receipt before creating a run, uses an idempotent message nonce, and retries unacknowledged results after restarts. PostgreSQL advisory locks serialize each connection across replicas. Credentials are encrypted at rest and never returned by the status endpoint.

Pausing stops new claims and continues status delivery for existing work. Company OS cancellation is propagated into the run and job queue. The executor observes cancellation on its next lease heartbeat. Failures remain visible for human inspection; the dispatcher does not silently retry failed company work. Successful run summaries complete the corresponding Company OS work request.

## Desktop and persistence boundary

Agent commands run as an unprivileged user. Cloud credentials stay in the API and worker. Screens use an authenticated gateway with distinct viewing and takeover capabilities; releasing the takeover lease closes its active connection. Only the gateway port is tunneled. Tenant ownership is checked on every provider operation.

Agent homes use immutable, integrity-checked blobs and revision manifests with conditional pointer updates in R2. Runtime disks are temporary. Files are checkpointed through the shared home-store contract; a terminated Modal computer can be recreated from its durable home. Command output is currently delivered when each command finishes, and PTY is explicitly unsupported by this adapter.

## Verification

The deterministic adapter tests cover tenant boundaries, missing-computer recovery, control leases, object integrity, concurrent revision updates, and symlink escape prevention. The workforce PostgreSQL test opts in with `VERIFY_DATABASE=1` and `DATABASE_URL`; its Company OS peer is mocked. The browser workforce test mocks the integration response and captures desktop/mobile light/dark states. Provider canaries are separate from these offline tests and must verify real storage, desktop streaming, cancellation, and an authorized model run before production acceptance.

The native mobile app does not yet expose workforce setup. Configure the connection in the responsive web app; spawned bots and conversations use the existing shared runtime.


## Company OS sign-in

Hosted Cadre can use Company OS as its OAuth identity and workforce authority.
Company OS owns authentication through Convex Auth. Cadre uses Better Auth as a
server-side OAuth client and app session store; Clerk is not required. Local
installations retain their optional email/password authentication.

Register a confidential OAuth client at your Company OS `/api/oauth/register`
with `identity_access: true`, `token_endpoint_auth_method: "client_secret_post"`,
`grant_types: ["authorization_code", "refresh_token"]`, and an exact redirect URI
of `https://<cadre-domain>/api/auth/oauth2/callback/company-os`. The consent screen
must disclose the name and verified email shared with Cadre. Configure these
server-only variables on both API and worker:

- `AUTH_PROVIDER=convex-company-os`
- `COMPANY_OS_OAUTH_ORIGIN=https://<company-os-domain>`
- `COMPANY_OS_OAUTH_CLIENT_ID` and `COMPANY_OS_OAUTH_CLIENT_SECRET`
- `BETTER_AUTH_URL` and `WEB_ORIGIN` set to the same canonical Cadre HTTPS origin
- A stable `BETTER_AUTH_SECRET` for app sessions and encrypted OAuth tokens

The login page uses authorization code flow with S256 PKCE, state, issuer checks,
and same-origin return paths. A verified Company OS email is required. Existing
Cadre accounts with matching email can link only after that identity verification;
new hosted accounts must pass the configured signup email allowlist.

The selected company and permissions come from consent. The workforce uses the
same revocable grant, refreshes credentials server-side under a database lock,
and starts with assignments paused. Refresh retains the Company OS key identity
so existing installation and dispatch receipts survive rotation. Removing company
membership, reducing the role below granted permissions, expiring or revoking the
grant blocks access and sync. Reusing a refresh token revokes its family.

OAuth access and refresh tokens are encrypted in the app database and never
returned by the browser session/status endpoints. Workers update their encrypted
MCP credential when a grant refreshes. Changing the authorized company requires
reconnecting the original workforce company; it cannot silently redirect work.

Hosted login is supported in the web app. The native mobile client points to the
web login for this mode; local email/password installations keep native sign-in.
The black icon is inverted for dark mode, the favicon follows the system theme,
and the social sharing card lives under `/brand/cadre-social.png`.
