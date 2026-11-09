# PR Title
```
feat: add Mola as a sandbox provider
```

# PR Body

## What
Adds Mola (https://mola.sh, open source at https://github.com/obaid/mola-core) as a sandbox provider for Rakazo. Mola provides instant Linux computers running Ubuntu 24.04 XFCE desktops with Chrome, each in its own VM. Can be self-hosted with QEMU/KVM or used as a managed service at cloud.mola.sh.

## Why
Expands Rakazo's sandbox provider options with an open-source alternative that supports both self-hosted and managed deployments. Mola offers fast machine creation (~1 second), Ubuntu-based environments, and can run on existing infrastructure without external dependencies, making it attractive for teams that want control over their infrastructure or need an open-source solution.

## Changes
- Implemented `MolaSandboxProvider` following the same pattern as existing providers (Boat, E2B, Daytona)
- Added REST API integration using Mola's documented endpoints:
  - `POST /v1/machines` - Create and start machine (https://github.com/obaid/mola-core/blob/main/docs/api.md#post-v1machines)
  - `GET /v1/machines/{id}` - Get machine status (https://github.com/obaid/mola-core/blob/main/docs/api.md#get-v1machinesid)
  - `POST /v1/machines/{id}/start` - Start stopped machine (https://github.com/obaid/mola-core/blob/main/docs/api.md#post-v1machinesidstart)
  - `POST /v1/machines/{id}/stop` - Stop machine (https://github.com/obaid/mola-core/blob/main/docs/api.md#post-v1machinesidstop)
  - `DELETE /v1/machines/{id}` - Destroy machine (https://github.com/obaid/mola-core/blob/main/docs/api.md#delete-v1machinesid)
  - `POST /v1/machines/{id}/actions` - Execute actions (https://github.com/obaid/mola-core/blob/main/docs/api.md#actions):
    - `exec` - Shell commands with timeout (https://github.com/obaid/mola-core/blob/main/docs/api.md#shell)
    - `read_file` / `write_file` - File operations (https://github.com/obaid/mola-core/blob/main/docs/api.md#files)
    - `screenshot` - Screen capture (https://github.com/obaid/mola-core/blob/main/docs/api.md#screen)
    - `click`, `move`, `scroll`, `type`, `key` - Input actions (https://github.com/obaid/mola-core/blob/main/docs/api.md#input)
  - `POST /v1/machines/{id}/desktop` - Get desktop viewer URL (https://github.com/obaid/mola-core/blob/main/docs/api.md#post-v1machinesiddesktop)
- Added configuration via environment variables: `MOLA_API_KEY` (required), `MOLA_API_URL` (optional, defaults to https://cloud.mola.sh/api/v1)
- Registered provider in settings UI with API key and URL fields
- Updated documentation in `docs/self-host-sandbox-providers.md` and `.env.example`
- Added marketing site integration in `apps/www/src/sandboxes/`
- Machine sizes: standard (2 vCPU, 4 GB), large (4 vCPU, 8 GB), xlarge (8 vCPU, 16 GB)

### Implementation Details
- Workspace stored at `/home/dev/rakazo-home` on Ubuntu machines
- Ephemeral VMs - workspace export/import provides persistence boundary
- Machines support Ubuntu 24.04 XFCE desktop with pre-installed Chrome
- Default screen resolution: 1280x800
- File operations limited to 1 MiB per file per Mola API constraints
- Command timeouts: 1-120 seconds per Mola API limits
- Desktop viewer tickets expire in 60 seconds (single-use)

## Risk
None. New optional provider alongside existing ones (E2B, Boat, Daytona, etc.). Defaults to `none` if API key is missing, same as other remote providers. No changes to existing provider code, default configuration, or core interfaces.

## Tested
- Passes full TypeScript typecheck (`pnpm check`)
- Basic unit tests for provider construction, capabilities, and configuration
- Code follows existing provider patterns (Boat, Daytona, E2B structure)
- All Mola API endpoints verified against official documentation at https://github.com/obaid/mola-core/blob/main/docs/api.md

Not tested (requires live Mola instance):
- Full integration tests with actual machine provisioning and lifecycle
- Workspace save/restore cycles  
- Real command execution and file operations
- Screen capture and desktop viewer access
- Error handling with actual API failures

CI will validate lint rules and remaining test suite. Full end-to-end testing needs a Mola API key (self-hosted or cloud.mola.sh).

### Known Limitations (per Mola API)
- No native PTY/terminal support - commands execute via REST API with captured stdout/stderr
- No snapshot/restore API (Rakazo's workspace export/import provides persistence)
- No background work inspection API
- Single display per machine (no multi-screen support)
- File operations: 1 MiB limit per file (Mola API constraint)
- Input via REST actions not integrated with Rakazo's real-time input system (marked as unimplemented)
- Port tunnels (`/v1/machines/{id}/tunnels`) and WebSocket action sessions (`/v1/machines/{id}/session`) exist in Mola API but not yet integrated

These limitations don't block standard bot workflows: running commands, managing files, taking screenshots, and viewing the desktop. The provider implements what Mola's current API supports.

---

## Files Changed
```
Modified (8 files):
  .env.example
  apps/www/src/pricing.ts
  apps/www/src/sandboxes/index.ts
  docs/self-host-sandbox-providers.md
  packages/adapters/src/computer-provider-registry.ts
  packages/adapters/src/sandbox-factory.ts
  packages/adapters/src/sandbox-provider-env.ts
  packages/contracts/src/ids.ts

Added (4 files):
  apps/www/src/sandboxes/mola.ts
  packages/adapters/src/mola-sandbox.test.ts
  packages/adapters/src/mola-sandbox.ts
  packages/adapters/src/mola-settings.ts
```

Total: ~600 lines added across 12 files
