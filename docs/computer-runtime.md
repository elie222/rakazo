# Computer runtime

Rakazo keeps the agent runtime and the computer runtime separate:

```text
chat/API -> one Pi agent session -> Rakazo computer tools -> SandboxProvider -> E2B (first cloud backend)
                                                   |-> Docker
                                                   |-> desktop/fake

SandboxProvider workspace <-> AgentHomeStore <-> Rakazo-owned DATA_DIR
```

Pi runs in the Rakazo API/worker process. It is not installed in, or executed by, E2B. The built-in tools are ordinary Pi tools, not Claude- or MCP-specific tools, so any model exposed through Pi can call them. Screen operation still requires a model that can accept image tool results and reason about screenshots.

## Computer contract

`SandboxProvider` is the provider boundary. A backend must implement:

- lifecycle: provision/reconnect, stop, and destroy;
- desktop: observe, ordered batched actions, user input, and a live screen session;
- execution: commands inside the machine;
- files: list/read/write plus complete workspace import/export.

The model gets `computer_observe`, batched `computer_act`, `open_path`, `launch_app`, `shell`, and file tools. An action can settle and return the resulting screenshot in one call. Identical consecutive frames keep their metadata but omit duplicate image bytes from model context.

Human input and agent input may coexist. “Take control” changes whether the embedded viewer accepts user input; it does not create an exclusive machine lock or automatically pause an active run. `request_takeover` remains available when the model explicitly needs protected input or human judgment.

## E2B backend

The first cloud implementation uses `@e2b/desktop` directly. Rakazo provisions or reconnects the desktop, maintains its authenticated live-view URL, captures PNG observations, performs mouse/keyboard/scroll/app actions, executes shell commands, and accesses files through the E2B SDK.

The database stores the provider kind and opaque `providerRef`. That reference is an acceleration path, not durable data. It is passed back only to the same provider kind. A missing machine or a provider-kind change creates a replacement and restores its workspace through the provider-neutral contract.

## Persistence

The portable bot workspace is the durable boundary. E2B uses `/home/user/rakazo-home`; Docker and local providers expose the equivalent bot home. Browser profiles are rooted under `.browser-profiles` in that workspace on E2B. Rakazo checkpoints transferred workspaces into `AgentHomeStore` at run completion or failure, before explicit stop, and before idle suspension. Docker mounts the Rakazo-owned home directly and only advances its revision marker at those boundaries. New or replacement machines import the latest stored workspace before use.

`LocalAgentHomeStore` currently keeps the latest workspace under `DATA_DIR/homes/<bot-id>` and checkpoint metadata separately under `DATA_DIR/home-revisions`. Replacements are staged before the current copy is swapped, and checkpoints are serialized per bot. This implementation is latest-only rather than an immutable revision archive. Production deployments must put `DATA_DIR` on a Rakazo-owned persistent volume, encrypt that volume at rest, and include it in off-host backups. The storage interface is deliberately independent of E2B so an object-store-backed implementation can replace the local volume without changing agent tools or sandbox providers.

Before exporting a remote workspace, the E2B backend quiesces desktop browsers so profile databases and login state are copied consistently. It excludes only transient cache/lock files inside `.browser-profiles`; similarly named project files remain durable.

The disposable OS image is not a portable disk snapshot. System packages installed outside the workspace are lost when moving to another provider; durable machine customization should be represented by a reproducible image or setup recipe. This is what makes a future backend switch practical instead of trying to translate vendor-specific VM snapshots.

## Verification

Offline tests cover tool-result images, action parsing, provider conformance, workspace checkpoint/restore, E2B SDK translation, and lifecycle integration. They never call a model or live sandbox.

The explicit acceptance test requires Docker (for temporary Postgres), `E2B_API_KEY`, `OPENROUTER_API_KEY`, and a vision-capable OpenRouter model id:

```bash
COMPUTER_E2E_MODEL=<vision-capable-openrouter-model-id> pnpm e2e:computer
```

It starts the full API, provisions a real E2B desktop, serves a deterministic page inside the sandbox, and asks a real model to observe and click a button. The button creates a server-side marker; the test then requires the model to use terminal and file tools and verifies both the marker and recorded tool calls. Finally, it destroys the provider machine, boots a replacement through the stale provider reference, and verifies that the external checkpoint restored the model-created file. The command is opt-in and is not run by `pnpm verify:fast`, `pnpm verify`, or CI unless invoked explicitly.
