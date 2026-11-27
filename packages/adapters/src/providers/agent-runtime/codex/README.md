# Text-only app-server protocol experiment

This is an **unregistered, non-production protocol slice**, not a usable primary
runtime. It cannot launch a process, authenticate an account, select a connection,
resume a session, access a workspace or execute a tool. No descriptor, barrel export,
executor dispatch or deployment flag enables it.

The protocol mapping is adapted from the original primary-harness prototype's
app-server flow (PR #1400, commit `6c4e0f16767bd9656551a6b29cb0d8d1b5119fc9`).
Its historical compatibility target is `0.162.1`, not a statement that this release
is current or safe. No SDK/package dependency or executable is installed here.

Unit fixtures exercise request sequencing, text and cumulative usage, identity
checks, denied server requests, unknown item rejection, explicit completion and
cleanup. They do **not** establish actual vendor compatibility or OS isolation.
The protocol is deliberately strict; additional native lifecycle notifications
must be observed and tested before extending its allowlist.

## Before enabling a runtime

- Pin a reviewed official release and run the real binary against a local fake API.
  Inspect every outgoing model request to prove native tools are absent, including
  tools introduced by catalogs, config, plugins or feature defaults. Fail closed
  on a version or policy mismatch. `environments: []` alone is not proof.
- Supply enforced filesystem, process-tree and endpoint-restricted egress isolation.
  An operator-provided executable path or attestation alone is not enforcement.
  Use fresh disposable state with no inherited home, auth, config, workspace,
  service sockets or environment; restrict writes to disposable runtime state.
- Add bounded JSONL framing, RPC correlation, timeout/abort-aware reads and complete
  process-tree teardown. Validate API-key-only connection settings before launch;
  reject native login, images, tools, history/resume and unsupported callbacks.
- Exercise that transport via the existing `AgentRuntime` contract, including
  concurrent independent runs, cancellation during startup/read, crash cleanup,
  credential isolation and teardown after early consumer exit.

Refusing a tool notification after it occurs is only a protocol tripwire. It does
not undo an action. Accordingly this slice intentionally has no selectable runtime.
