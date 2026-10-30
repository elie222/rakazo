# Computer runtime

Rakazo keeps the agent runtime and the computer runtime separate:

```text
chat/API -> one Pi agent session -> Rakazo computer tools -> SandboxProvider -> E2B / Daytona / Boat
                                                   |-> Docker
                                                   |-> desktop/fake

SandboxProvider workspace <-> AgentHomeStore <-> Rakazo-owned DATA_DIR
```

Pi runs in the Rakazo API/worker process. It is not installed in, or executed by, E2B. The built-in tools are ordinary Pi tools, not Claude- or MCP-specific tools, so any model exposed through Pi can call them. Screen operation still requires a model that can accept image tool results and reason about screenshots.

## Computer contract

Each workspace gets one Team Computer by default. Bots share its files and installed tools. Each Team bot starts in `bots/<bot-id>/`, while deliberately shared work belongs in `shared/`. These folders organize work but are not security boundaries: every Team bot can access the full Team workspace. A bot can instead use a Private Computer, where the whole workspace is its home.

Each active Team bot gets its own X display and Chrome process, with a persistent Chrome profile keyed to the bot's identity. Logins, cookies, and browser history are independent. Profiles are never cloned from another bot, merged, or deleted when a desktop is released. Both bots keep their changes; reopening a bot uses its existing profile even when its display slot changes. Team runs use fenced per-bot database leases: different bots can operate concurrently, and one bot has only one computer driver at a time.

Docker, E2B, Daytona, and Boat use the same Linux desktop lifecycle commands. Remote adapters share allocation, observation, actions, and control handling; provider code supplies command execution, persistent workspace paths, and screen URLs. Boat exposes the shared runtime through protected ports from its `hostPort` API instead of its default desktop API. View and control use separate revocable websocket capabilities; teardown disconnects clients before a display slot is reused. A failed teardown keeps the slot reserved for retry.

Desktop stacks start lazily when a bot uses graphical tools. There is no configured desktop cap by default; a computer can host 100 or more bot profiles, and simultaneous desktops are bounded by its RAM, CPU, process capacity, and available local debugger ports. Docker operators can set a positive `SANDBOX_TEAM_SCREEN_LIMIT` to cap active desktops (`0` leaves it unset). Requests beyond an explicit limit return `MULTI_SCREEN_UNAVAILABLE`; shell and file tools remain available. All desktops share one token-protected screen gateway, so adding desktops does not require publishing more ports. Each view/control capability targets a unique local Unix socket; recycling a display cannot redirect an old connection to its next bot. Inactive bots do not each run Chrome. Closing a viewer leaves the desktop intact. On Docker and on the Linux desktops of Boat, E2B, Daytona, and Railway computers, successful run completion revokes the run's control but retains that bot's screen and browser for the next run, keeping the existing view open and its signed-in sessions. A browser that does restart restores its last session. If a configured Team screen limit is reached, the oldest idle, uncontrolled screen may be torn down for a new bot. Failed or canceled runs and explicit computer deletion still tear down their screens. CreateOS screens are released as before. Whole-computer idle shutdown stops remaining processes while preserving the workspace. There is no separate inactivity timer per desktop. Persistent profiles consume disk but do not require a running Chrome process.

`SandboxProvider` is the provider boundary. A backend must implement:

- lifecycle: provision/reconnect, stop, and destroy;
- desktop: observe, ordered batched actions, user input, and a live screen session;
- execution: commands inside the machine;
- files: list/read/write plus complete workspace import/export.

On supported graphical computers the model gets `browser_navigate`, `browser_snapshot`, and `browser_act` for page text and element refs. The default `computer` browser provider drives the visible Chromium tab through the sandbox's optional `pageBrowser` contract. Docker implements that contract through the same managed-screen and lease checks as desktop controls; update the computer image to install the helper. Other providers keep their existing desktop tools until they implement the contract. No hosted browser service or API key is required.

The computer container is the security boundary. Team bots share the OS user, workspace, browser profiles, and shell/X11 access; screen leases coordinate tool calls, not mutually untrusted processes inside that computer. CDP binds only to the container's loopback interface and is not published as a host port. Use separate computers when workloads require isolation.

The helper uses an isolated script world, masks password values, and rejects stale refs instead of retargeting replacement elements. Snapshots include bounded page text and up to 80 interactive elements. Frames and unsupported interactions require desktop tools. A failed action reports confirmed progress and whether its outcome is uncertain: inspect the current state before continuing and never replay completed or uncertain actions automatically. For models without vision, request takeover if page tools cannot operate.

Fake computers and explicit `BROWSER_PROVIDER=fake|emulator` use an in-process session for tests. These sessions are not the live logged-in browser. Browser mutations share the existing teaching guard and workspace checkpoint flow. `computer_observe`, batched `computer_act`, `open_path`, `launch_app`, `shell`, and file tools remain available according to the computer and model capabilities. Identical consecutive desktop frames keep their metadata but omit duplicate image bytes from model context. The tool result says the previous screenshot remains valid. After repeated identical visual actions leave the frame unchanged, computer_act refuses another copy of that action and points the agent at page text tools.

Human input and agent input may coexist on distinct Team screens. “Take control” grants the user an exclusive control lease on that bot’s screen so the embedded viewer accepts input. For a Team bot, takeover is refused with HTTP 409 (“Stop the bot first”) while that bot holds a live computer execution lease or an active run, unless the run is `waiting_takeover` (the bot asked for protected input). Stop the bot first, then take control; after release, the agent may continue. `request_takeover` remains available when the model explicitly needs protected input or human judgment. On providers that do not bill while running, a waiting takeover keeps the computer awake for 30 minutes after the request so the login, 2FA, or CAPTCHA page is still open when the user arrives; after that the computer suspends while the run keeps waiting. Billed providers follow the normal idle timer, which the request restarts.

## Terminal and files

The web and desktop computer view opens a terminal and a file browser from a dock over the screen. The dock's browser button hides those windows, keeping their sessions, so the whole screen is visible again.

**Terminal**
- The Activity view always shows what the bot did on its computer, live and from history. Each action is recorded as a `computer.command` event:
  - `shell` commands, with the redacted command and the tail of their output;
  - `write_file`, `attach_file`, `open_path`, and `launch_app`, as one line each, with the size for writes and the error if they failed.

  Read-only tools (`read_file`, `list_files`) are left out. The bot can still run commands while the user holds control, so the feed never goes away.
- Without control (for example after it was released or expired), an "Open shell" button takes control again and switches to the shell.
- A user holding control also gets a Shell tab with an interactive shell. It starts on first use, stays connected across tab switches, and reconnects to a fresh shell if the connection drops. `computer.terminalUrl` starts a small PTY server in the computer beside the screen gateway.
  - It is bound to the display's control token and reached through the same sealed capability and gateway as the control screen. Later sessions under the same lease (another tab, a reopened window) join that server with their own shell, so open shells keep running.
  - It runs as the computer's workspace user (never root), with the same environment as the bot's `shell` tool. Docker execs inherit the container's non-root user; E2B, Daytona, and Boat use the same command runner as `shell`. When the computer runs as a host uid without a passwd entry (Docker on macOS), the terminal names it `rakazo` through nss_wrapper for its own session, so prompts and `whoami` work; `/etc/passwd` stays unchanged.
  - Releasing control, expiry, or screen teardown stops it, disconnects every shell, and removes its session files.
- Providers opt in through `SandboxProvider.connectTerminal`. Docker, E2B, Daytona, and Boat support it. Host (`desktop`) computers never expose a browser shell; other computers without it show only Activity.
- The fake provider serves an emulated shell from a loopback websocket gateway that speaks the same frame protocol. Tests can then drive the browser terminal through the sealed capability and web proxy without exposing a host shell.

**Files**
- Browsing and text preview work on stopped computers through the stored workspace.
- While the Files window is visible, the open folder refreshes every few seconds and after each bot command, so changes from a shell or the bot appear without reopening.
- Download needs a running computer.
- Upload also needs control. Uploads land under the bot's workspace path and are capped at the attachment size limit.

## Screen connection diagnostics

The web service logs `screen.proxy.target_rejected`, `screen.proxy.http_failed`, `screen.proxy.http_upstream_response`, `screen.proxy.websocket_handshake_failed`, `screen.proxy.websocket_error`, `screen.proxy.websocket_upgraded`, `screen.proxy.websocket_closed`, and revocation events. Each event includes a random `screen.connection_id` and a view/control policy. WebSocket close events include whether the upstream handshake completed, its duration, and the side that initiated the close (`client`, `upstream`, or `revoked`). Logs omit capability URLs, socket tokens, provider hostnames, cookies, and request headers.

The web and Electron screen frame is sandboxed, so the app cannot look inside it. Before framing a proxied page the app fetches it once and shows a fixed, localized reason for a proxy refusal (for example "The screen did not respond.") in place of the screen. The proxy rewrites every noVNC page with a small reporter that posts `loading` as soon as the page runs and then `connecting`, `connected`, `failed` (whose status text is never displayed) or `disconnected` to the app; Rakazo's own `embed.html` sets the same noVNC classes so Docker computers report too. A `failed` report, or nothing past `loading` within 15 seconds, shows the error and Retry instead of a blank frame. The mobile app follows the same screen reports and offers Retry on connection failure. A frame that stays silent means the document never executed in that browser; one that stops at `loading` means noVNC's modules never finished evaluating; a `failed` report means the page ran and noVNC could not connect.

The shim also removes `VideoDecoder` from the page. noVNC releases before 1.7 probe WebCodecs H.264 support with a top-level `await`, and on some Android devices `VideoDecoder.flush()` never returns, which leaves the page on `noVNC_loading` with no error. Screens never use H.264. Every proxied screen response is sent with `Cache-Control: no-transform`, so a CDN in front of the web service does not inject scripts into or minify the page.

When the screen shows a connection error, check whether `computer.screenUrl` succeeded in the API logs, then inspect web-service `screen.proxy.*` events around the same time. On `screen.proxy.target_rejected`, read `reason`: `invalid_path` is not a session path (API not contacted); `authority_rejected` is a non-OK API response (expired, revoked, or an API error); `invalid_authority_response` is an OK response with an invalid or malformed target body; `authority_unavailable` is a request, connectivity, or timeout failure. An upstream error or non-101 handshake points to the provider screen gateway. An upgraded connection that closes quickly points to a transport drop after the handshake. If the API issued a URL but no web-service event appears, inspect the browser Network panel and its WebSocket request. Do not paste the full capability URL into an issue or log.

## E2B backend

The E2B adapter uses `@e2b/desktop` and the Novita adapter uses `novita-sandbox` for machine lifecycle, shell commands, files, and port URLs. Every bot desktop uses the shared Linux runtime, including the first bot. Its X display, screenshots, input, and view/control transports follow the same lifecycle as the other managed providers.

## Daytona backend

The database stores the provider kind and opaque `providerRef`. That reference is an acceleration path, not durable data. It is passed back only to the same provider kind. A missing machine or a provider-kind change creates a replacement and restores its workspace through the provider-neutral contract.

## Boat backend

The Boat adapter uses Boat's official TypeScript SDK for lifecycle, command, and file operations. It creates and resumes sandboxes with `noEnv: true`, as required when a third party supplies the API key, and keeps a two-hour TTL refreshed while the computer is active. The shared runtime creates each bot's display and noVNC transports, exposed through protected Boat port hosting. Rakazo's encrypted screen capability proxy binds the view/control policy and keeps the provider credentials out of browser-visible URLs. Observations and actions target the assigned bot display.

Boat stop archives the machine and resume reconnects the same opaque sandbox id. Each bot’s Chrome profile lives under the portable workspace and is included in checkpoint/export. Boat states the API cannot recover from (deleted, cancelled, snapshot data expired, or an `error` that recover cannot fix) are reported as gone, so the computer is replaced and restored from its last checkpoint.

## Persistence

The portable computer workspace is the durable boundary. E2B uses `/home/user/rakazo-home`; Docker and local providers expose the equivalent home. Browser profiles are rooted under `.browser-profiles` in that workspace on E2B. Rakazo checkpoints transferred workspaces into `AgentHomeStore` at run completion or failure, before explicit stop, and before idle suspension. Docker mounts the Rakazo-owned home directly and only advances its revision marker at those boundaries. New or replacement machines import the latest stored workspace before use.

`LocalAgentHomeStore` keeps the latest workspace under `DATA_DIR/homes/<computer-home-key>` and checkpoint metadata separately under `DATA_DIR/home-revisions`. Replacements are staged before the current copy is swapped, and checkpoints are serialized per computer. This implementation is latest-only rather than an immutable revision archive. Deployments using it must put `DATA_DIR` on a Rakazo-owned persistent volume, encrypt that volume at rest, and include it in off-host backups.

With `OBJECT_STORAGE_BUCKET` set, `ObjectAgentHomeStore` makes an S3-compatible bucket the source of truth and `DATA_DIR/homes` a cache, without changing agent tools or sandbox providers. Each checkpoint packs the home into one archive of directories and regular files, seals it with the home's data key (64 KiB AES-256-GCM segments bound to the home's storage id and revision), uploads it as `homes/<storage id>/<revision>`, advances the revision on the computer row, and deletes the previous object. Reads, restores and Docker boots first bring the cache up to the stored revision. The data key is wrapped by the space's content key and stored on the computer row, so deleting the computer makes its objects unreadable; the worker's reconciler then deletes objects no computer owns. Restores accept only relative paths without `.` or `..` segments, create only directories and regular files, and enforce size and entry limits. See [self-hosting](./self-host-storage.md#bot-homes-in-object-storage).

Before exporting a remote workspace, remote backends quiesce desktop browsers so profile databases and login state are copied consistently. Run checkpoints defer while another bot holds an execution or user-control lease; the last finishing run or idle job saves the shared workspace. Idle shutdown claims the computer before exporting, preventing a new bot from starting during the snapshot. All home saves and restores exclude rebuildable caches (`.cache`, `.npm`, `.pnpm-store`, `.yarn/cache`), dependencies (`node_modules`, `.venv`), Python bytecode (`__pycache__`), build output (`.next`, `.turbo`), `*.log` files and regular files named `core` or `core.<digits>` at any depth. A directory such as `packages/core` stays. The existing transient browser caches, components and locks inside `.browser-profiles` are also excluded; login state stays. Excluded directories are skipped before traversal and do not count toward save limits. Saving never removes them from a running computer. Homes over 5 GiB or one million files stay running unsaved, with a system note in the bots’ threads.

The disposable OS image is not a portable disk snapshot. System packages installed outside the workspace are lost when moving to another provider; durable machine customization should be represented by a reproducible image or setup recipe. This is what makes a future backend switch practical instead of trying to translate vendor-specific VM snapshots.

Docker computers include `uv` for rootless Python CLI installs. Run `uv tool install <package>`; the tool environments, command shims, managed Python versions, and cache stay under the persistent home. This installs Python command-line tools, not system packages such as `apt` dependencies. The image also ships GitHub's `gh` CLI; bots authenticate the CLI through device flow, and gh stores that credential under the persistent home. `pdftotext`, `pandoc`, and `openpyxl` are available to extract text from PDFs, documents, and spreadsheets.

## Verification

The [agent verification guide](agent-verification.md) also describes a deterministic
contacts-export replay through real Pi, with either a stateful fake computer or
real Docker Chromium. It requires no inference and complements the vision
acceptance test below.

Offline tests cover tool-result images, action parsing, provider conformance (including the page-browser adapter and computer_act fallback), workspace checkpoint/restore, provider SDK translation, lifecycle integration, and the real Boat adapter against an in-memory Boat API. They never call a model or live sandbox.

The explicit acceptance test requires Docker (for temporary Postgres), `E2B_API_KEY`, `OPENROUTER_API_KEY`, and a vision-capable OpenRouter model id:

```bash
COMPUTER_E2E_MODEL=<vision-capable-openrouter-model-id> pnpm test:computer
```

It starts the full API, provisions a real E2B desktop, serves a deterministic page inside the sandbox, and asks a real model to observe and click a button. The button creates a server-side marker; the test then requires the model to use terminal and file tools and verifies both the marker and recorded tool calls. Finally, it destroys the provider machine, boots a replacement through the stale provider reference, and verifies that the external checkpoint restored the model-created file. The command is opt-in and is not run by `pnpm test` or CI unless invoked explicitly.

### Docker desktop lifecycle regression

Build the computer image, then run `VERIFY_DOCKER_TEAM_SCREENS=1 pnpm exec vitest run infra/sandboxes/supervisor/src/team-desktops.docker.test.ts`. Set `RAKAZO_COMPUTER_IMAGE` to select a prebuilt image. The test uses an isolated Docker container with networking disabled and fake browser state; it verifies parallel Chrome desktops visiting local fixture sites, independent cookies, profile persistence after release, transport teardown, and rejection of old view/control tokens after slot reuse. It runs both Docker supervision and the command path used by remote providers. Default unit tests exercise profile persistence, allocation, and lease fencing offline without Docker.

## Computer maintenance

Update and recovery run as durable background jobs. A computer-wide reservation
excludes new execution leases, stop, takeover, idle suspension, and computer-mode
changes while the operation saves and replaces the workspace. Progress is stored
separately from the computer's provisioning fence. Web and Electron show a dialog
or compact background pill; mobile uses a native sheet. Reopening the app restores
active operations and failures from the API.

Update explicitly rebuilds with the configured provider/image; `canUpdate` means
the computer supports that action, not that a newer image was detected. Provider
migration and image-version discovery are not part of this UI. Updates checkpoint
live work before teardown; an update that fails before teardown leaves a
running computer running, so Recover can still save that work first. Recover
stops rather than rebuild when it exported the work but cannot store or record
it. Recovery can fall back to the last saved workspace, so its failure action
warns that unsaved work may be lost.

The reconciler republishes queued operations after a missed enqueue. Jobs already
claimed are never destructively replayed. A worker that stops heartbeating for ten
minutes is marked interrupted and remains reserved until its provider calls settle.
Only then is recovery available. If a worker has permanently disappeared, an operator
must stop the affected workers and verify that provider operations have stopped before
using the server-owner-only **Release computer** action in the interrupted dialog.
Its confirmation requires an explicit assertion that workers and provider operations
have stopped, then makes normal recovery available. The corresponding RPC is
`computer/releaseInterrupted` with `{ id, workersStopped: true }`; it accepts only
interrupted operations in the owner’s current workspace. A stale heartbeat alone
never authorizes takeover. Progress reports
actual lifecycle stages rather than estimated percentages; workspace files and
browser profiles are portable, while system packages outside the workspace are not.
