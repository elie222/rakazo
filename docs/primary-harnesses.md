# Primary harness profiles (experimental)

Rakazo keeps the bot's identity, visible conversation, memory, permissions, routines,
and group membership. An optional execution profile selects the agent execution loop
for that bot. Unconfigured bots continue through the existing Pi runtime. Non-Pi
turns do not ask Pi to interpret or delegate the request. Auto Review retains its
independent runtime and usage records. Mediated helper availability depends on
the account mode, as described below.

## Scope

The initial supported deployment is a restricted Linux Docker supervisor. Web,
Electron (shared web UI), and mobile configure the same backend profile. Desktop,
Railway, E2B, and other sandbox providers without the isolated bidirectional process
contract reject native profiles; they never run the CLI on the API or worker host.

Pinned engines:

- Pi: the existing 0.87.1 runtime, unchanged by default.
- Claude: official Claude Agent SDK 0.3.300, Anthropic messages protocol.
- Codex: official Codex 0.162.1 app-server, OpenAI Responses protocol.
- Kimi Code: official `@moonshot-ai/kimi-code@2.2.0` ACP runtime, configured for
  the OpenAI Chat Completions provider protocol. The native control protocol and
  model-provider protocol are separate choices.

Kimi Code 2.2.0 is pinned to the [official release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.2.0).
The archived Python Kimi CLI/Wire runtime is no longer launched. Existing legacy
profiles are not rewritten: Advanced settings keeps their binding visible and
requires **New revision** to create a profile with the supported pin. This creates
a new profile revision/session scope rather than reusing a legacy Wire session.
Protocol updates require new conformance fixtures and review of permissions and
session behavior; a version string alone does not establish compatibility.

Native agents use Rakazo's mediated tools for reading, writing, shell commands,
memory, messaging, group handoff, and integrations. Those operations run against
the bot's authorized computer and retain existing approval/effect rules. Vendor
native tools, arbitrary MCP servers, project hooks, and native subagents are not
permitted. Native image and uploaded-audio support is model- and protocol-scoped,
as described below. Unsupported media fails explicitly rather than switching
engines or substituting transcription. Rakazo-mediated helpers are supported
with the limits documented below.

## Capability matrix

| Capability | Pi default | Claude Agent / Codex / Kimi Code |
| --- | --- | --- |
| Direct, group/handoff, routine turns | Existing behavior | Profile snapshotted at enqueue; Kimi native login permits only interactive user/messaging turns |
| Shell, file, memory, integration tools | Existing behavior | Rakazo-mediated tools and existing approvals |
| Questions, protected input, takeover | Existing behavior | Parent bot uses existing durable input/approval paths |
| Short helper agents | Existing behavior | API-key profiles: same-harness/account/model, four distinct requests/run, depth one; native-login profiles: unavailable |
| Native session continuation | Existing behavior | Private scoped transcripts + validated checkpoint/epoch |
| Worker crash / uncertain effect | Existing recovery | Interrupted run fails closed; fresh user run can start a new epoch |
| Images, uploaded audio, live-call transcripts | Existing image/transcript behavior | Separate media matrix below; no engine or transcription fallback |
| Vendor-native shell/hooks/MCP/subagents | Not applicable | Disabled; no bypass of Rakazo tools |
| API-key account | Existing behavior | Explicit selected account; Claude also supports explicit bearer-key authentication |
| Native subscription login | Existing behavior | Codex and Kimi: eligible self-hosted personal deployments only; Claude: disabled pending authorization |
| Imported OAuth/session tokens | Existing behavior | Rejected; native sign-in must use the isolated official engine |
| Execution environment | Existing providers | Restricted rootful Linux Docker; operator verification required |

A missing account, unsupported version/protocol, unavailable environment or revoked
permission produces an actionable failed run. None changes the selected harness or
billing account automatically. Helper model override and nested delegation requests
also fail explicitly. This matrix describes implemented paths, not live provider or
real-host acceptance results; those validation limits are listed below.

## Authentication and entitlement matrix

Technical support does not establish permission to offer a provider's subscription
through a product. The following distinguishes the implemented boundary from
upstream conditions reviewed on **2026-10-15**. Recheck the official sources before
deployment; this is not provider approval or a legal determination.

| Account / flow | Upstream support and conditions | Rakazo behavior |
| --- | --- | --- |
| Claude API or compatible provider key | SDK supports API authentication; provider billing and service terms apply | Selected key, explicit Anthropic endpoint, authentication scheme and optional model-role mappings |
| Claude subscription | Subscription SDK usage exists, but own-product Claude.ai sign-in remains restricted without approval; hosting unmodified Claude Code has separate conditions | No native subscription sign-in or imported subscription tokens; blocked pending authorization for this integration |
| Codex ChatGPT subscription | Official app-server owns browser/device login, persistence and refresh; documentation permits continued local/open-source integration and excludes commercial or hosted-service authentication | Native device-code flow only, behind the self-hosted personal-use gate; no token import or resale |
| Kimi Code subscription | Native login and supported third-party coding tools are documented; personal interactive use only, with no resale, client-identity spoofing or non-interactive automation | Native regional device login; routine, webhook and other non-user-triggered runs rejected; native identity remains unchanged |
| Subscription-issued API key | A key's shape does not determine entitlement; Kimi Code can issue keys for coding-plan usage | Key-based routing is supported, but does not waive the plan's restrictions |

Sources: [Claude SDK authentication restriction](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude subscription usage update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
[Claude hosting and credential conditions](https://code.claude.com/docs/en/legal-and-compliance),
[Codex app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints),
[Kimi Code membership and third-party tool access](https://www.kimi.com/en/help/kimi-code/membership-guide),
and [Kimi Code usage guidelines](https://www.kimi.com/en/help/kimi-code/community-guidelines).

OpenAI recommends migration from app-server authentication to
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source).
That separate flow has registration, consent and host-identity requirements; paid
or remotely hosted applications require the provider's appropriate program.
Rakazo does not implement SIWC token sharing or claim that a self-hosted flag
authorizes a commercial service. Native login is disabled by default.

Kimi's interactive-use restriction also applies to subscription-backed API keys,
including when used through Claude Agent. The native-login trigger guard cannot
identify the entitlement behind an arbitrary API key. Use appropriately licensed
platform/API credentials for scheduled or batch work; do not use key-based
configuration to bypass subscription restrictions.

### Claude-compatible provider configuration

Claude profiles use `protocol: "anthropic"`. `authScheme` is explicit and immutable:
`"api-key"` supplies the selected key as `ANTHROPIC_API_KEY`; `"bearer"` supplies it
as `ANTHROPIC_AUTH_TOKEN`. The adapter sets only the chosen mechanism. Bearer-key
authentication is not Claude subscription OAuth. The endpoint is passed as
`ANTHROPIC_BASE_URL`; it is never rewritten into an OpenAI endpoint.

`modelId` selects the primary model. Optional `modelRoles` maps `haiku`, `sonnet`,
`opus`, and `fable` to the corresponding `ANTHROPIC_DEFAULT_*_MODEL` variables,
and `subagent` to `CLAUDE_CODE_SUBAGENT_MODEL`. Only these named fields are accepted;
arbitrary environment variables, settings files and hooks cannot be imported.
Role mappings do not enable native subagents or change the same-model helper rule.
Other harnesses reject bearer selection or nonempty model-role mappings.

Provider-documented routing examples, subject to current model availability:

| Provider account | Anthropic endpoint | `authScheme` | Model selection and roles |
| --- | --- | --- | --- |
| Z.AI coding-plan/API key | `https://api.z.ai/api/anthropic` | `bearer` | The current guide maps Haiku to `glm-5.3-flash[1m]` and Sonnet/Opus to `glm-5.3[1m]`; choose an entitled primary `modelId` explicitly |
| Kimi Code key, global service | `https://api.kimi.ai/coding/` | `api-key` | For example, `modelId: "k3-256k"`, with all five roles set to `k3-256k`, following the guide's complete role-mapping requirement |

These values come from [Z.AI's Claude Code guide](https://docs.z.ai/devpack/tool/claude)
and [Kimi's Claude Code guide](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).
They are configuration examples, not live compatibility results for the pinned
SDK. Vendor guides may also specify context-window and effort controls; those
settings are not implicitly imported by `modelRoles`. A `[1m]` model alias alone
does not prove Rakazo's selected model/context configuration supports that window.
Use the guide for the account's region and current model, and test authentication,
tools, continuation, quota failures and cancellation separately.

Kimi's own native-login profile instead uses its managed Chat Completions route:
`https://api.kimi.ai/coding/v1` for `global`, or
`https://api.kimi.com/coding/v1` for `mainland-cn`. Codex native login uses the
official `https://chatgpt.com/backend-api/codex` route, not the API-key endpoint.
These endpoints are fixed by the native descriptor; custom endpoints cannot
receive native subscription credentials. See the
[pinned Kimi regional configuration](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/oauth/src/region.ts)
and [pinned Codex provider routing](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/model-provider-info/src/lib.rs).

## Native media matrix

Transport support is an upper bound, not a promise that an arbitrary model accepts
media. Each immutable native profile declares its selected model's
`inputModalities` (`image`, `audio`, or both). The declaration defaults to `[]` for
new profiles, old rows, and old snapshots; it never inherits media support from
another account, a provider name, or an unrelated connection default. Known
image-incompatible model configurations are rejected. A declaration does not
replace a live compatibility test of a custom endpoint/model.

| Input / output | Claude Agent 0.3.300 | Codex 0.162.1 | Kimi Code 2.2.0 |
| --- | --- | --- | --- |
| Uploaded/current/history images | Implemented with explicit model `image` declaration; actual-engine offline probe passed | Implemented with explicit model `image` declaration; actual-engine offline probe passed | Implemented through ACP with explicit model `image` declaration; actual-engine offline probe passed |
| Mediated tool-result images | Implemented and actual-engine offline probe passed | Implemented and actual-engine offline probe passed | Implemented and actual-engine offline probe passed |
| Native uploaded audio | Unsupported by this harness | Implemented only for a declared audio-capable custom Responses endpoint/model; actual-engine offline audio/resume probe passed | Unsupported: ACP advertises `audio: false` |
| Official OpenAI Responses audio | Not applicable | Rejected, including provider aliases pointing at OpenAI/ChatGPT domains | Not applicable |
| Live-call/dictation transcripts | Existing text path | Existing text path | Existing text path |

The Kimi restriction follows its [versioned ACP contract](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/docs/en/reference/kimi-acp.md).
The presence of a file-upload endpoint does not mean a native model accepts audio.
Pi's existing image handling is unchanged; native uploaded audio is not enabled
for Pi. The normal file chooser accepts raw audio separately from dictation and
live calls. Native uploaded audio is never replaced with an STT transcript. Live
calls continue to use their existing transcription provider and send text.

In Advanced settings, **Model accepts images** and, only for eligible custom Codex
endpoints, **Model accepts uploaded audio** are explicit model declarations.
Changing the model, account, provider, protocol, harness, or endpoint clears the
draft declarations. Selected profiles distinguish unavailable transport inputs
from supported inputs not enabled for that model. No blanket media capability is
inferred from choosing a harness.

### Media authorization, limits, and history

Media is hydrated from database-authorized artifact IDs for the active user and
space. Runtime code does not fetch attachment URLs or interpret names as paths.
Stored size, MIME, SHA-256 digest, safe storage reference, and decoded image/audio
container checks must pass before Rakazo passes original bytes to the native harness.
The Claude SDK and Kimi ACP may optimize/re-encode large images before HTTP: small
image probes preserve bytes, but byte-for-byte provider payload identity is not
promised for that SDK. Rakazo does not substitute a transcript or perform an
implicit audio conversion.
PNG, JPEG, WebP, and GIF images are supported by the shared boundary. Audio upload
containers are WAV, MPEG/MP3, MP4/M4A, WebM, Ogg, and FLAC; each endpoint/model may
accept a narrower set and is not automatically transcoded.

A native prompt has a shared limit of four media items and 10 MiB of decoded bytes
across current input and hydrated history. Images also have a 40-million-pixel
validation limit, at most 256 animation frames, and a five-second decode timeout. History hydration considers at most three recent media-bearing
turns, preserving message/speaker attribution. Current input consumes the budget
first; unavailable or over-budget historical media is replaced with an explicit
omission notice, not silently treated as seen. Current unsupported or invalid
media fails the turn. Native session/profile revisions retain their existing
account, bot, thread, epoch, and lease isolation; media does not create a shared
cross-profile cache. Tool images pass the same media validation boundary.

## Enable on a controlled deployment

1. Apply the additive database migration with the normal migration workflow.
2. Build the pinned runtime image:

   ```sh
   docker build -t rakazo/harness:local infra/sandboxes/harness
   ```

3. Configure and independently verify the supervisor's restricted host firewall
   according to the computer networking documentation. Native runtime bridges are
   distinct from team-computer bridges; access to private destinations and the
   Docker host must be blocked. Merely naming a bridge does not enforce egress.
4. Set PRIMARY_HARNESSES_ENABLED=true in API, worker, and supervisor;
   SANDBOX_COMPUTER_EGRESS=restricted and PRIMARY_HARNESS_EGRESS_VERIFIED=true in
   supervisor. The verification flag is operator attestation, not an automatic
   firewall test. Do not set it before verifying the rules on that host.
5. Open a bot's Advanced settings, create a named profile, and select the harness,
   explicit connection account, protocol, endpoint, and model. Profile versions
   are immutable. Sharing a profile reuses authorized connection configuration,
   not mutable bot/session state.

No provider account is required for Pi's existing default path beyond its current
configuration. Key-based native profiles use an explicitly selected connection.
For eligible user-operated deployments, also set
`PRIMARY_HARNESS_NATIVE_LOGIN_MODE=self-hosted-personal` in API and worker. In
connection settings, select Codex or Kimi native sign-in, the owned Docker computer,
and Kimi's region where applicable, then acknowledge personal self-hosted use.
Complete the displayed device code on the validated official provider site; Rakazo
never asks for subscription tokens. Wait for the connection to become ready before
selecting it in a profile. Web, Electron and mobile use the same backend flow.

The operator gate is an attestation, not an entitlement detector. Commercial/hosted
service use is not enabled by setting it. Sign-in can establish ongoing provider
access and inference can consume subscription allowance or incur charges. Default
tests never call a provider; live sign-in and provider acceptance remain separate
operator actions.

## Identity, credentials, and continuity

The database snapshots the addressed bot's immutable profile at run insertion,
including exact credential and credential-secret references, version, actual
computer, and model-scoped input declarations. The additive media migration sets
existing profile rows to `inputModalities = []`; it does not upgrade their pinned
runtime or silently enable media. This covers direct messages, group mentions/handoffs, routine wakes,
and other enqueue paths. Changing the bot or space default cannot reroute queued
work. Starting a run and every mediated tool call recheck membership, ownership,
and credential revocation. Periodic checks cancel in-flight native processes when
run authorization or ownership disappears. Revocation cannot undo an operation
already accepted by an external service.

For native-login connections, the stored connection value is a nonsecret
`native_login` descriptor, not a provider token. It binds the harness, installation,
owner/space, selected computer identity, connection ID, credential epoch, state,
and region. The secret-store abstraction protects this descriptor as it does other
connection values, but provider access/refresh credentials remain in an isolated,
separately labeled private credential volume on the selected computer. Only the
official engine reads, writes and refreshes those credentials. The auth bridge
returns bounded device instructions, state and allowlisted account display fields;
it does not return credential files, bearer tokens or native server auth tokens.

Each native credential scope has an exclusive supervisor lease covering login,
inference, status and logout. Concurrent use fails closed rather than running two
refresh writers. Native-login profiles therefore do not advertise or execute
`run_subagent`; their account lease cannot be shared with a helper process. API-key
profiles retain the helper limits below. This account lease is independent of the
per-thread session lease.

Two profiles can select the same provider/model with different accounts. Missing,
revoked, or replaced accounts fail closed; there is no newest-account lookup,
provider fallback, deployment-key fallback, or automatic engine switch for an
explicit profile. Endpoints are protocol-specific and independently validated;
an Anthropic endpoint is never normalized as an OpenAI endpoint.

Native session bindings are scoped to space, user, bot, thread, profile revision,
and epoch. The isolated runtime gets a private session volume and ephemeral
HOME/configuration. API keys are injected only into the isolated process and are
not persisted in native session volumes. Native-login credentials deliberately
survive process restarts in their separate scoped credential volume; they are
never stored in conversation/session data. Team workspaces are never mounted into
the native runtime.

Codex's native credential file is linked into the disposable home. Kimi's native
credential directory, refresh-lock directory and stable device identity are linked
separately, preserving the vendor's atomic credential replacement and refresh
behavior. Entire native homes are never shared across bots. Trusted regional
configuration is reconstructed instead of copying user settings, hooks or MCP
servers. Native login processes have no workspace or session mounts and expose
only start/status/cancel/logout. Kimi's local auth API binds only to loopback and
its temporary server token is never exposed to the browser.

Disconnect/reconnect fences the old descriptor by rotating the credential epoch
before native logout or cleanup. Queued work bound to the replaced reference fails
closed. A disconnected UI state means Rakazo access is fenced; it is not a promise
of upstream token revocation when the selected computer is offline or still leased.
Replacing an account connection rotates the session scope before another run can resume.
Changing harness/profile or clearing conversation history creates a new native
session. Canonical Rakazo history remains the durable user-visible source of truth;
other group bots' messages keep their speaker identity. Native checkpoints are not
portable between engines or accounts.

A running session is fenced by run ID and lease fence. An unexplained EOF or process
failure is not a successful turn. Interrupted work is not automatically replayed;
a fresh user turn may start a new scoped epoch using visible context. Approval and
input pauses are distinguished from crashes. Approvals remain bound to Rakazo's
existing durable effect/approval records. Duplicate, stale, expired, or foreign
answers cannot grant another run permission.

## Isolation and lifecycle

The supervisor launches a separate non-root container with read-only root filesystem,
private HOME/tmp, scoped session storage, resource limits, and no workspace/home or
Docker socket mount. Only trusted pinned runtime code is present, so repository
configuration cannot replace an endpoint, key, hook, MCP server, or approval policy.
All filesystem and shell activity is mediated through Rakazo's existing sandbox
and authorization layer. A worktree is not a security boundary.

An explicit execution-profile run takes an exclusive Team-computer execution
lease before model or tool work. It waits while any other bot holds a live lease,
and ordinary Pi runs wait while that exclusive lease is held. This deliberately
serializes access to a shared checkout instead of assuming concurrent edits are
safe. Existing per-bot fencing, expiry, renewal, takeover and queued retry behavior
remain in effect. Unconfigured Pi bots may still run concurrently with one another
when no exclusive profile lease is present. This does not create Git worktrees or
coordinate independent human/external processes modifying the same files.

The bidirectional transport bounds frame size, queued messages, tool results,
request counts, output, and run time. Kimi journal inspection uses 64 KiB incremental reads,
16 MiB record/batch bounds, and a 1 GiB session-log limit. Hitting a native-session
capacity limit fails explicitly; after an interrupted run, a fresh user turn can
reconstruct a new scoped epoch from Rakazo history. Unknown security requests are denied.
Cancellation, disconnect, timeout, and computer shutdown terminate the entire
runtime container. Credentials and provider error bodies are not written to
protocol diagnostics. Usage unavailable from a vendor remains unknown, never zero.

Recognized authentication, quota/rate-limit, network, model, context and temporary
provider failures produce static actionable errors. For example, authentication
asks the user to reconnect; quota asks them to check allowance or retry later;
network errors ask them to check the endpoint/network. Raw upstream response text
is not displayed. Unknown failures remain generic, and no error silently changes
the account, endpoint or harness.

## Rollback

Disable `PRIMARY_HARNESS_NATIVE_LOGIN_MODE` to reject new native sign-ins and
native-login turns without changing key-based profiles. Existing accounts remain
available for local disconnect and queued cleanup. Disable PRIMARY_HARNESSES_ENABLED to
reject all new native turns. Stop or cancel active
native runs before changing runtime images. Keep new tables and audit records;
downgrading code does not imply deleting session/profile data. An existing native
profile does not become Pi implicitly. Select Pi explicitly to change that bot.

## Verification

Offline unit suites cover profile/account isolation, immutable queue snapshots,
scoped sessions and fencing, protocol fragmentation/errors/terminal behavior,
mediated tool calls, cancellation, and settings interactions. PostgreSQL integration
requires a disposable migrated PostgreSQL instance; actual container isolation
requires a configured Docker host. These are separate acceptance layers.

Provider compatibility must be tested separately with deliberately supplied test
accounts. Z.AI and Kimi publish Claude-compatible configurations; that documentation
is not proof that these pinned versions pass live authentication, tools, resume,
quota errors, and cancellation. Do not describe fixture success as live compatibility.
No live provider compatibility is claimed by this document.

### Private state retention and cleanup

Stopping/replacing a computer preserves scoped session and credential volumes for
continuation. History clearing, session-epoch rotation, and bot, thread or profile
deletion immediately invalidate affected session bindings and durably enqueue
their obsolete private state in the `NativeStateCleanup` outbox. Credential
rotation, revocation and deletion immediately retire the selected account's session
families; native-login disconnect/reconnect also enqueue the exact old credential
namespace after fencing its descriptor. Sibling accounts sharing an underlying
secret are not retired. Invalidated state cannot be adopted by a
new run while physical deletion is pending.

The worker reconciliation leader retries pending cleanup. Session cleanup targets
the exact obsolete root/helper family; credential cleanup targets the exact
connection epoch. The supervisor verifies installation and ownership labels,
reserves each target against concurrent launch, and refuses active leases or
mounted volumes. An unavailable computer or active run leaves a retryable queue
entry rather than triggering broader deletion. Cleanup does not depend on the
native feature being enabled. Computer destruction terminates native processes
and removes the installation's correctly labeled private volumes, including when
the base computer container is already missing.

Cleanup is bound to the installation fingerprint derived from the supervisor
token. Rotating that token does not authorize the new installation namespace to
adopt or delete old volumes. Operators must retain enough old-namespace ownership
information to arrange explicit cleanup after stopping its runs; pending cleanup
must not be redirected to an unrelated namespace. Apply retention, encryption and
backup policy to Docker storage as to other private conversation data. Never
remove volumes belonging to an active run, and do not treat an application-level
disconnect as proof that provider-side tokens have been revoked.

### Reproduce acceptance checks

Run the default offline suite with `pnpm test`. Direct profile, session, transport,
and runtime specifications live beside their implementations. They use fake
credentials and deterministic process/provider fixtures.

On a disposable migrated PostgreSQL database, run:

```sh
VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/execution-profiles.postgres.test.ts
```

`DATABASE_URL` must already identify that test database. This suite creates and
removes its own synthetic records; do not point it at a production database.

On a configured Linux Docker host with the trusted image already built and the
restricted firewall independently verified, run:

```sh
RAKAZO_HARNESS_DOCKER_TESTS=1 PRIMARY_HARNESS_EGRESS_VERIFIED=true \
  pnpm exec vitest run infra/sandboxes/supervisor/src/isolated-process.docker.test.ts
```

This checks real duplex input/output, credential-free Docker metadata, process-tree
termination, and scoped persistence. It does not build or pull an image, modify
firewall rules, or make a model-provider call. Mocked firewall tests alone do not
establish real host enforcement.

## Dependency terms and display names

These engines retain their upstream terms; Rakazo's repository license does not
relicense bundled vendor software. Deployment operators should review the linked
terms and preserve required dependency license and attribution notices:

- Claude Agent SDK: [SDK license and branding guidance](https://code.claude.com/docs/en/agent-sdk/overview),
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), and
  [authentication and hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).
  The embedded SDK integration uses the selected user's provider key, with the
  explicit authentication scheme described above. It does not offer
  Claude.ai login, collect subscription tokens, resell provider usage, or modify
  the vendor binary. The UI label is **Claude Agent**, as recommended for dropdowns.
  An operator must independently assess applicable hosting and account terms;
  this implementation is not legal approval of a deployment.
- Codex 0.162.1: [Apache-2.0 license](https://github.com/openai/codex/blob/rust-v0.162.1/LICENSE).
  Provider service and subscription-authentication conditions remain separate from
  the software license; the self-hosted gate does not authorize hosted resale.
- Kimi Code 2.2.0: the [pinned npm metadata](https://registry.npmjs.org/@moonshot-ai/kimi-code/2.2.0)
  declares MIT and Node >=22.19.0. See the [pinned release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.2.0)
  and [versioned source and license](https://github.com/MoonshotAI/kimi-code/tree/%40moonshot-ai%2Fkimi-code%402.2.0).
  Review its current package notices and provider service terms independently of
  Rakazo's license. Legacy Python Kimi CLI licensing does not establish the new
  runtime's terms or protocol compatibility.

## Mediated helper limits

`run_subagent` launches another isolated instance of the selected native harness,
with the exact same account, model, protocol, and profile revision. Helpers retain
the parent bot's authorization and use the same mediated tool/effect boundary.
They have a separate private session epoch and separately attributed usage.
Vendor-native subagents remain disabled. Explicit helper model overrides are
rejected; there is no implicit Pi or provider fallback.

This helper path is available only for key-based profiles. Codex/Kimi native-login
profiles disable it because the private credential volume has an exclusive account
lease. Native-login helper requests fail explicitly instead of borrowing a Pi/API
account or opening another concurrent native credential writer.

A run allows at most four distinct helper requests, at one level of nesting.
Repeating the same normalized helper name, task, and instructions as a new call
within that run is rejected to avoid ambiguous approval continuation. Helper results are
bounded to 1 KiB of UTF-8 text, with an explicit truncation marker. Helpers cannot
ask the user or request takeover themselves. A protected-tool approval pause
propagates through the parent; checkpoints are persisted before child effects.
Same-run approval continuation can restore a matching helper invocation and its
completed result. A new user run never reuses an old helper result. Helper session
volumes follow the private-session retention policy above.

### Ambiguous mutation replay after a pause

A host tool response alone does not prove the native engine durably recorded it.
For every native harness, a same-run continuation rejects a mutation whose exact
tool/arguments fingerprint was already completed before the current attempt,
unless it is the exact persisted approved effect being resumed. This prevents a
missing native result from becoming a second side effect with a new call ID.
Distinct requests, read-only built-ins and fresh user runs remain available;
an intentional identical mutation must start a new user turn. The run reports
this ambiguity explicitly rather than silently repeating or pretending success.
This guard supplements, rather than replaces, the existing external-effect audit
and cannot make an arbitrary remote API transaction atomic with the database.

## Reproduce real-engine offline probes

Ordinary tests use deterministic protocol fixtures and skip vendor subprocesses.
The opt-in integration tests execute the actual pinned engines against local HTTP
API stubs using fake keys, then replace HOME and resume their private session data.
They check tool declarations, bridged calls, explicit completion, streaming, usage,
native identity, and absence of the fake key in persisted state. These tests do not
validate Docker isolation or live provider compatibility.

Install the image's exact npm packages in a disposable directory and provide its
absolute `node_modules` path as `RAKAZO_NATIVE_HARNESS_TEST_MODULES`. Kimi now uses
the pinned npm package and ACP; no legacy Python CLI environment is used. This
variable is a dependency path, never an account credential. From the repository root:

```sh
RAKAZO_NATIVE_HARNESS_TEST_MODULES=/absolute/test-deps/node_modules \
pnpm exec vitest run \
  packages/adapters/src/primary-harness-offline-integration.test.ts \
  packages/adapters/src/primary-harness-kimi-offline-integration.test.ts \
  packages/adapters/src/primary-harness-auth-codex-offline-integration.test.ts \
  packages/adapters/src/primary-harness-auth-kimi.test.ts
```

The npm pins are `@anthropic-ai/claude-agent-sdk@0.3.300`,
`@anthropic-ai/sdk@0.134.0`, `@modelcontextprotocol/sdk@1.30.0`, `zod@4.6.2`,
`@openai/codex@0.162.1`, and `@moonshot-ai/kimi-code@2.2.0`. Dependency installation is separate from tests, so
ordinary unit tests never download vendor programs or contact a model provider.
The dedicated CI compatibility job installs these exact engines separately and
runs the opt-in probes; it uses only loopback fake APIs. The PostgreSQL journey
job also includes the execution-profile migration suite.

Native-auth probes use synthetic device grants and fake refresh tokens, never
existing native homes or real accounts. Kimi's actual 2.2.0 probe covers device
sign-in, native refresh, a native-login primary turn with a mediated tool, private
session resume, status from a fresh ephemeral home, and logout. Its test-only
transport blocks public-network access. Codex's auth probe uses the pinned native
issuer override with a loopback fixture. These probes establish pinned protocol
compatibility, not provider authorization, live subscription entitlement or real
Docker credential isolation.

### Current media acceptance status

Claude Agent SDK and Codex app-server actual-engine offline image, tool-image, and
fresh/resumed-session probes have passed against local fake endpoints. Kimi Code
2.2 actual ACP current/history-image, mediated screenshot, and fresh/resumed tool
probes also passed with byte-preserving small-image payloads. Codex custom-endpoint raw
audio and resumed-session probes passed using an explicitly supplied model catalog
that declares audio input. Large-media probes also pass: duplicated native media echoes are filtered inside
the restricted runtime while forwarded model output stays bounded. Claude/Kimi native large-image optimization means
these results do not imply universal byte identity after native preprocessing.
Older Kimi CLI 1.51.0 results are not evidence for the replacement.

No paid/live provider call, real-host Docker isolation/firewall acceptance, or
PostgreSQL migration execution is claimed here. Browser screenshot capture was
blocked by the execution environment's Chromium Unix-socket and separate-loopback
restrictions; the offline Playwright scenarios require CI screenshot evidence.
The web fixture does not capture native mobile UI. Repository-wide checks and
protocol mocks do not replace these outstanding acceptance gates.

Kimi Code ACP's [pinned image conversion implementation](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/convert.ts)
can compress oversized images and adds an explicit warning that fine detail may
be lost. Original validated bytes reach ACP; optimized provider bytes are not
claimed to be identical. Provider-error media stripping/degradation is separately
detected in the native journal and fails the run before another host tool effect.
