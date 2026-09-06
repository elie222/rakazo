# Computer runtime

Rakazo keeps the agent runtime and the computer runtime separate:

```text
chat/API -> one Pi agent session -> Rakazo computer tools -> SandboxProvider -> E2B / Daytona / Box
                                                   |-> Docker
                                                   |-> desktop/fake

SandboxProvider workspace <-> AgentHomeStore <-> Rakazo-owned DATA_DIR
```

Pi runs in the Rakazo API/worker process. It is not installed in, or executed by, E2B. The built-in tools are ordinary Pi tools, not Claude- or MCP-specific tools, so any model exposed through Pi can call them. Screen operation still requires a model that can accept image tool results and reason about screenshots.

## Computer contract

Each workspace gets one Team Computer by default. Bots share its files and installed tools. Each Team bot starts in `bots/<bot-id>/`, while deliberately shared work belongs in `shared/`. These folders organize work but are not security boundaries: every Team bot can access the full Team workspace. A bot can instead use a Private Computer, where the whole workspace is its home.

Each active Team bot gets its own X display and Chrome process, with a persistent Chrome profile keyed to the bot's identity. Logins, cookies, and browser history are independent. Profiles are never cloned from another bot, merged, or deleted when a desktop is released. Both bots keep their changes; reopening a bot uses its existing profile even when its display slot changes. Team runs use fenced per-bot database leases: different bots can operate concurrently, and one bot has only one computer driver at a time.

Docker, E2B, Daytona, and Box use the same Linux desktop lifecycle commands. Remote adapters share allocation, observation, actions, and control handling; provider code supplies command execution, persistent workspace paths, and screen URLs. Box exposes the shared runtime through protected `host <port> --private` routes instead of its default desktop API. View and control use separate revocable websocket capabilities; teardown disconnects clients before a display slot is reused. A failed teardown keeps the slot reserved for retry.

Desktop stacks start lazily when a bot uses graphical tools. Up to eight bot desktops can be active per computer; Docker can lower this with `SANDBOX_TEAM_SCREEN_LIMIT`. Additional graphical requests return `MULTI_SCREEN_UNAVAILABLE`; shell and file tools remain available. Inactive bots do not each run Chrome. Closing a viewer leaves the desktop intact. Run completion releases that bot's desktop, and whole-computer idle shutdown stops remaining processes while preserving the workspace. There is no separate inactivity timer per desktop. Persistent profiles consume disk but do not require a running Chrome process.

`SandboxProvider` is the provider boundary. A backend must implement:

- lifecycle: provision/reconnect, stop, and destroy;
- desktop: observe, ordered batched actions, user input, and a live screen session;
- execution: commands inside the machine;
- files: list/read/write plus complete workspace import/export.

On supported graphical computers the model gets `browser_navigate`, `browser_snapshot`, and `browser_act` for page text and element refs. The default `computer` browser provider drives the visible Chromium tab through the sandbox's optional `pageBrowser` contract. Docker implements that contract through the same managed-screen and lease checks as desktop controls; update the computer image to install the helper. Other providers keep their existing desktop tools until they implement the contract. No hosted browser service or API key is required.

The computer container is the security boundary. Team bots share the OS user, workspace, browser profiles, and shell/X11 access; screen leases coordinate tool calls, not mutually untrusted processes inside that computer. CDP binds only to the container's loopback interface and is not published as a host port. Use separate computers when workloads require isolation.

The helper uses an isolated script world, masks password values, and rejects stale refs instead of retargeting replacement elements. Snapshots include bounded page text and up to 80 interactive elements. Frames and unsupported interactions require desktop tools. A failed action reports confirmed progress and whether its outcome is uncertain: inspect the current state before continuing and never replay completed or uncertain actions automatically. For models without vision, request takeover if page tools cannot operate.

Fake computers and explicit `BROWSER_PROVIDER=fake|emulator` use an in-process session for tests. These sessions are not the live logged-in browser. Browser mutations share the existing teaching guard and workspace checkpoint flow. `computer_observe`, batched `computer_act`, `open_path`, `launch_app`, `shell`, and file tools remain available according to the computer and model capabilities. Identical consecutive desktop frames keep their metadata but omit duplicate image bytes from model context.

Human input and agent input may coexist on distinct Team screens. “Take control” grants the user an exclusive control lease on that bot’s screen so the embedded viewer accepts input. For a Team bot, takeover is refused with HTTP 409 (“Stop the bot first”) while that bot holds a live computer execution lease or an active run, unless the run is `waiting_takeover` (the bot asked for protected input). Stop the bot first, then take control; after release, the agent may continue. `request_takeover` remains available when the model explicitly needs protected input or human judgment.

## E2B backend

The first cloud implementation uses `@e2b/desktop` directly. Rakazo provisions or reconnects the desktop, maintains its authenticated live-view URL, captures PNG observations, performs mouse/keyboard/scroll/app actions, executes shell commands, and accesses files through the E2B SDK.

On Team Computers, bot index 0 uses the E2B desktop stream and SDK screenshot/input APIs. Additional Team bots get their own Xvfb display, view port (`6080 + 2i`), and interactive control port (`6081 + 2i`) spawned inside the same sandbox via shell commands. Takeover opens the signed control URL for that bot's screen, not the shared primary stream.

## Daytona backend

The database stores the provider kind and opaque `providerRef`. That reference is an acceleration path, not durable data. It is passed back only to the same provider kind. A missing machine or a provider-kind change creates a replacement and restores its workspace through the provider-neutral contract.

## Box backend

The Box adapter uses ASCII's official TypeScript SDK for lifecycle, command, desktop, and file operations. It creates and resumes boxes with `noEnv: true`, as required when a third party supplies the API key, and keeps a two-hour TTL refreshed while the computer is active. The provider's authenticated noVNC page is kept behind Rakazo's encrypted screen capability proxy, which binds the view/control policy and keeps the Box desktop secret out of browser-visible URLs; observations and model actions use the same primary `DISPLAY=:0` through ImageMagick and `xdotool`.

Box stop archives the machine and resume reconnects the same opaque box id. Each bot’s Chrome profile lives under the portable workspace and is included in checkpoint/export. The Box emulator uses the same multi-screen contract as the other managed-provider emulators.

## Persistence

The portable computer workspace is the durable boundary. E2B uses `/home/user/rakazo-home`; Docker and local providers expose the equivalent home. Browser profiles are rooted under `.browser-profiles` in that workspace on E2B. Rakazo checkpoints transferred workspaces into `AgentHomeStore` at run completion or failure, before explicit stop, and before idle suspension. Docker mounts the Rakazo-owned home directly and only advances its revision marker at those boundaries. New or replacement machines import the latest stored workspace before use.

`LocalAgentHomeStore` currently keeps the latest workspace under `DATA_DIR/homes/<computer-home-key>` and checkpoint metadata separately under `DATA_DIR/home-revisions`. Replacements are staged before the current copy is swapped, and checkpoints are serialized per computer. This implementation is latest-only rather than an immutable revision archive. Production deployments must put `DATA_DIR` on a Rakazo-owned persistent volume, encrypt that volume at rest, and include it in off-host backups. The storage interface is deliberately independent of E2B so an object-store-backed implementation can replace the local volume without changing agent tools or sandbox providers.

Before exporting a remote workspace, remote backends quiesce desktop browsers so profile databases and login state are copied consistently. Run checkpoints defer while another bot holds an execution or user-control lease; the last finishing run or idle job saves the shared workspace. Idle shutdown claims the computer before exporting, preventing a new bot from starting during the snapshot. They exclude only transient cache/lock files inside `.browser-profiles`; similarly named project files remain durable.

The disposable OS image is not a portable disk snapshot. System packages installed outside the workspace are lost when moving to another provider; durable machine customization should be represented by a reproducible image or setup recipe. This is what makes a future backend switch practical instead of trying to translate vendor-specific VM snapshots.

## Verification

Offline tests cover tool-result images, action parsing, provider conformance (including the page-browser adapter and computer_act fallback), workspace checkpoint/restore, provider SDK translation, lifecycle integration, and multi-screen managed-provider emulators. They never call a model or live sandbox.

The explicit acceptance test requires Docker (for temporary Postgres), `E2B_API_KEY`, `OPENROUTER_API_KEY`, and a vision-capable OpenRouter model id:

```bash
COMPUTER_E2E_MODEL=<vision-capable-openrouter-model-id> pnpm test:computer
```

It starts the full API, provisions a real E2B desktop, serves a deterministic page inside the sandbox, and asks a real model to observe and click a button. The button creates a server-side marker; the test then requires the model to use terminal and file tools and verifies both the marker and recorded tool calls. Finally, it destroys the provider machine, boots a replacement through the stale provider reference, and verifies that the external checkpoint restored the model-created file. The command is opt-in and is not run by `pnpm test` or CI unless invoked explicitly.

### Docker desktop lifecycle regression

Build the computer image, then run `VERIFY_DOCKER_TEAM_SCREENS=1 pnpm exec vitest run infra/sandboxes/supervisor/src/team-desktops.docker.test.ts`. Set `RAKAZO_COMPUTER_IMAGE` to select a prebuilt image. The test uses an isolated Docker container with networking disabled and fake browser state; it verifies parallel Chrome desktops visiting local fixture sites, independent cookies, profile persistence after release, transport teardown, and rejection of old view/control tokens after slot reuse. It runs both Docker supervision and the command path used by remote providers. Default unit tests exercise profile persistence, allocation, and lease fencing offline without Docker.
