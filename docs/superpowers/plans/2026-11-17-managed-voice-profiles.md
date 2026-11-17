# Managed Voice Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load private per-bot voice profiles, enforce them during synthesis, and show their effective model and tuning in Rakazo without putting private values in public source.

**Architecture:** A startup-loaded, immutable registry under `DATA_DIR` is the single source of truth. The API uses it both to resolve synthesis and to expose an authorized read-only profile; adapters validate and translate their own opaque tuning settings. The existing Bot row remains unchanged, avoiding a second source of truth and a database migration.

**Tech Stack:** TypeScript, Zod, oRPC, React, TanStack Query, Vitest, Prisma test doubles, Docker Compose.

---

### Task 1: Align the existing Fish catalog test with the owned-only picker

**Files:**

- Modify: `packages/adapters/src/fish-audio-voice.test.ts`

- [ ] **Step 1: Replace public-catalog expectations with the approved owned-only behavior**

Keep pagination, cancellation, deadline and language tests focused on `self=true` requests. Assert
that no request without `self=true` is made and that only owned models are returned.

- [ ] **Step 2: Run the catalog test**

Run: `pnpm vitest run packages/adapters/src/fish-audio-voice.test.ts`

Expected: 17 tests pass and no network request escapes the test fetch stub.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/src/fish-audio-voice.test.ts
git commit -m "test: align private voice catalog coverage"
```

### Task 2: Add the immutable managed-profile registry

**Files:**

- Create: `apps/api/src/managed-voice-profiles.ts`
- Create: `apps/api/src/managed-voice-profiles.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/router.ts`

- [ ] **Step 1: Write failing parser and registry tests**

Test this public surface:

```ts
const registry = await loadManagedVoiceProfiles(dataDir);
expect(registry.forBot("c000000000000000000000000")).toEqual({
  botId: "c000000000000000000000000",
  voiceId: "test::voice-1",
  voiceLabel: "Test voice",
  model: "model-1",
  settings: { speed: 0.94 },
});
```

Also assert that an absent file returns an empty registry, duplicate bot ids fail, an unqualified
voice id fails, and unknown fields fail.

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run apps/api/src/managed-voice-profiles.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the smallest loader and immutable registry**

Use strict Zod schemas, `readFile`, and a `ReadonlyMap`. Export:

```ts
export interface ManagedVoiceProfile {
  botId: string;
  voiceId: string;
  voiceLabel: string;
  model?: string;
  settings?: Readonly<Record<string, unknown>>;
}

export interface ManagedVoiceProfiles {
  forBot(botId: string): ManagedVoiceProfile | undefined;
}

export async function loadManagedVoiceProfiles(dataDir: string): Promise<ManagedVoiceProfiles>;
```

Treat only `ENOENT` as an empty registry. Prefix every other parse/read error with
`managed-voice-profiles.json`.

- [ ] **Step 4: Load once during startup and pass through `RouterDeps`**

Call the loader after database initialization and add `managedVoiceProfiles` to `RouterDeps` and
the voice dependency object. Do not read the file per request.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run apps/api/src/managed-voice-profiles.test.ts`

Expected: PASS.

Run: `pnpm --filter @rakazo/api typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/managed-voice-profiles.ts apps/api/src/managed-voice-profiles.test.ts apps/api/src/app.ts apps/api/src/router.ts
git commit -m "feat: load managed voice profiles"
```

### Task 3: Use managed profiles for synthesis and lock voice writes

**Files:**

- Modify: `packages/adapter-kit/src/types.ts`
- Modify: `apps/api/src/voice.ts`
- Modify: `apps/api/src/voice.test.ts`
- Modify: `apps/api/src/routes/bots.ts`
- Modify: `apps/api/src/router.test.ts`

- [ ] **Step 1: Write failing synthesis tests**

For a Bot with a saved ordinary voice and a managed qualified voice, assert the adapter receives:

```ts
expect(synthesize).toHaveBeenCalledWith(
  expect.objectContaining({
    voiceId: "managed-voice",
    model: "managed-model",
    settings: { speed: 0.94 },
  }),
  expect.anything(),
);
```

Assert the connection is loaded from the managed qualified id and no default connection is used.

- [ ] **Step 2: Run the synthesis test and verify RED**

Run: `pnpm vitest run apps/api/src/voice.test.ts`

Expected: the managed-profile assertions fail because Bot state still wins.

- [ ] **Step 3: Extend the provider-neutral request and resolve profiles first**

Add `settings?: Readonly<Record<string, unknown>>` to `VoiceSynthesizeRequest`. In
`resolveVoiceTarget`, use the managed profile when a `botId` is present; require its qualified voice
id and pass its model/settings through `synthesizeVoice`.

- [ ] **Step 4: Write the failing lock test**

Call `bots.update` with `voiceId` for a managed bot and expect `CONFLICT` with
`This bot's voice is managed by the deployment.`. Prove unrelated Bot fields and unmanaged Bot
voice updates remain writable.

- [ ] **Step 5: Implement the route guard**

Before `commitBotUpdate`, reject only when `input.voiceId !== undefined` and the registry contains
the bot. Do not block `autoSpeak` or unrelated updates.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run apps/api/src/voice.test.ts apps/api/src/router.test.ts`

Expected: PASS.

```bash
git add packages/adapter-kit/src/types.ts apps/api/src/voice.ts apps/api/src/voice.test.ts apps/api/src/routes/bots.ts apps/api/src/router.test.ts
git commit -m "feat: enforce managed bot voices"
```

### Task 4: Move all tuning out of voice-id special cases

**Files:**

- Modify: `packages/adapters/src/elevenlabs-voice.ts`
- Modify: `packages/adapters/src/elevenlabs-voice-synthesize.test.ts`
- Modify: `packages/adapters/src/fish-audio-voice.ts`
- Create: `packages/adapters/src/fish-audio-voice-synthesize.test.ts`

- [ ] **Step 1: Write failing adapter tests for settings translation**

For the first adapter, pass:

```ts
settings: {
  stability: 0.4,
  similarityBoost: 0.6,
  style: 0.25,
  useSpeakerBoost: true,
  speed: 0.94,
}
```

Assert the request uses snake-case upstream fields. For the second adapter, pass:

```ts
settings: {
  temperature: 0.55,
  topP: 0.61,
  speed: 0.9,
  volume: -1,
  normalizeLoudness: true,
}
```

Assert the request uses the expected top-level and prosody fields. Assert an unknown key and an
out-of-range value reject before `fetch`.

- [ ] **Step 2: Run both tests and verify RED**

Run: `pnpm vitest run packages/adapters/src/elevenlabs-voice-synthesize.test.ts packages/adapters/src/fish-audio-voice-synthesize.test.ts`

Expected: FAIL because settings are ignored and the second test module is new.

- [ ] **Step 3: Add strict adapter-local schemas and remove private constants**

Parse `request.settings` only inside each adapter. Translate accepted camel-case fields to the
upstream body. Delete all voice-id constants and conditionals for private characters. Keep existing
provider defaults when `settings` is absent.

- [ ] **Step 4: Run adapter and API tests**

Run: `pnpm vitest run packages/adapters/src/elevenlabs-voice-synthesize.test.ts packages/adapters/src/fish-audio-voice-synthesize.test.ts apps/api/src/voice.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/elevenlabs-voice.ts packages/adapters/src/elevenlabs-voice-synthesize.test.ts packages/adapters/src/fish-audio-voice.ts packages/adapters/src/fish-audio-voice-synthesize.test.ts
git commit -m "refactor: drive voice tuning from profiles"
```

### Task 5: Expose the authorized profile and render it progressively

**Files:**

- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/voice.ts`
- Modify: `apps/api/src/voice.test.ts`
- Modify: `apps/web/src/pages/shell/bot-panel.tsx`
- Modify: `apps/web/src/pages/shell/bot-settings-sections.tsx`
- Modify: `apps/web/src/pages/shell/bot-panel.test.tsx`

- [ ] **Step 1: Write failing authorization and response tests**

Add `voice.profile({ botId })`, returning `null` for unmanaged bots and this safe shape for a managed
bot in the actor's Space:

```ts
{
  voiceLabel: "Test voice",
  connectionName: "Test connection",
  model: "model-1",
  settings: { speed: 0.94 },
}
```

Assert a Bot in another Space raises the existing isolation error.

- [ ] **Step 2: Run the API test and verify RED**

Run: `pnpm vitest run apps/api/src/voice.test.ts`

Expected: FAIL because `voice.profile` does not exist.

- [ ] **Step 3: Add the contract and handler**

Use a strict `ManagedVoiceProfileViewSchema`; authorize with a Space-scoped Bot lookup. Resolve the
connection display name from the existing dynamic voice catalog. Never return the source path or a
credential.

- [ ] **Step 4: Write the failing web test**

Mock a managed profile, open Advanced, and assert:

```ts
expect(screen.getByLabelText("Voice")).toBeDisabled();
expect(screen.getByText("Managed voice")).toBeVisible();
expect(screen.getByText("Test voice")).toBeVisible();
```

Open `Details` and assert the connection, model and flattened settings are visible. In the unmanaged
case, assert the existing picker stays enabled and no managed disclosure appears.

- [ ] **Step 5: Run the web test and verify RED**

Run: `pnpm vitest run apps/web/src/pages/shell/bot-panel.test.tsx`

Expected: FAIL because the profile query and managed UI are absent.

- [ ] **Step 6: Implement the minimal progressive UI**

Query the profile by `bot.id`, pass it to `VoiceGroup`, disable the picker when non-null, show one
`Managed voice` line, and place connection/model/settings inside the existing `Disclosure`
component. Keep `Read replies aloud` editable. Do not edit translation catalogs.

- [ ] **Step 7: Run tests, typecheck and format**

Run: `pnpm vitest run apps/api/src/voice.test.ts apps/web/src/pages/shell/bot-panel.test.tsx`

Expected: PASS.

Run: `pnpm --filter @rakazo/api typecheck && pnpm --filter @rakazo/web typecheck`

Expected: PASS.

Run: `pnpm exec biome check --write packages/contracts/src/domain.ts packages/contracts/src/rpc.ts apps/api/src/routes/account.ts apps/api/src/voice.ts apps/web/src/pages/shell/bot-panel.tsx apps/web/src/pages/shell/bot-settings-sections.tsx`

Expected: no remaining formatting errors.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/rpc.ts apps/api/src/routes/account.ts apps/api/src/voice.ts apps/api/src/voice.test.ts apps/web/src/pages/shell/bot-panel.tsx apps/web/src/pages/shell/bot-settings-sections.tsx apps/web/src/pages/shell/bot-panel.test.tsx
git commit -m "feat: show managed voice details"
```

### Task 6: Verify, package and prepare the private production profile

**Files:**

- Modify: `docs/self-host-configuration.md`
- Create outside Git: `/opt/rakazo/private/managed-voice-profiles.json`
- Modify outside Git: `/opt/rakazo/docker-compose.override.yml`

- [ ] **Step 1: Document the generic self-hosted file**

Document the schema, `DATA_DIR` location, startup failure behavior and read-only nature using only
fake ids and values.

- [ ] **Step 2: Run focused and repository verification**

Run: `pnpm vitest run apps/api/src/managed-voice-profiles.test.ts apps/api/src/voice.test.ts packages/adapters/src/elevenlabs-voice-synthesize.test.ts packages/adapters/src/fish-audio-voice-synthesize.test.ts packages/adapters/src/fish-audio-voice.test.ts apps/web/src/pages/shell/bot-panel.test.tsx`

Expected: PASS.

Run: `pnpm --filter @rakazo/api build && pnpm --filter @rakazo/web build`

Expected: PASS.

- [ ] **Step 3: Inspect the UI locally**

Open a fixture Bot with a fake managed profile, capture the Advanced Voice section, and review it
with `.agents/skills/ux-declutter/SKILL.md`. Confirm private production values are absent from the
screenshot and repository diff.

- [ ] **Step 4: Commit the generic feature**

```bash
git add docs/self-host-configuration.md docs/superpowers/specs/2026-11-17-managed-voice-profiles-design.md docs/superpowers/plans/2026-11-17-managed-voice-profiles.md
git commit -m "docs: explain managed voice profiles"
```

- [ ] **Step 5: Prepare but do not publicly push private deployment data**

Build the production file from the verified private voice registry, validate it with the new loader,
and add a read-only Compose mount. Keep the current API bundle as the rollback anchor. Do not put the
file, ids or tuning values in Git, logs, screenshots or a public PR.

- [ ] **Step 6: Production smoke check**

After deployment authorization, recreate API/web, run the existing health check, inspect the managed
profile through the authenticated UI, and synthesize one short line for each configured connection.
Verify the selected model/settings from structured request diagnostics without recording keys or
audio content.

Expected: health passes; managed bots use exact profiles; unmanaged bots and both voice connections
still work; image recreation keeps the profiles.
