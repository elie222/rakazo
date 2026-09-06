# Standalone Cadre upstream audit

Baseline: `elie222/rakazo` commit `f17887a2724d6cd457abe406a17c4c8721d0c013`. The fork preserves its Pi agent runtime, bot/thread model, persistent computer UI, file and browser tools, model selector, routines, groups, and native clients. This inventory covers every changed or added tracked path against that baseline at this release.

## Corrections

The public domain previously served a different Hermes application. It now points to this Rakazo fork. Making Company OS the only hosted login was an unjustified first-run dependency; production now uses the original email/password account flow (`AUTH_PROVIDER=local`). Company OS credentials do not activate an integration when that mode is selected, and its Workforce entry is hidden. Those optional modules remain dormant to preserve prior work; they are not prerequisites for a bot, model, computer, or task. No Company OS development is included in this correction.

On hosted installations, a configured deployment model skips provider setup. The user names a first bot and sends a message using the existing composer. Cloudflare, Modal, model credentials, job dispatch, and workspace persistence are service configuration. The customer does not deploy an external agent, assemble a fleet, or supply a model key.

The shared light background was warm off-white in upstream. Explicit product direction now sets white/black foundations and neutral grays; sans-serif UI typography and upstream structure remain. Responsive fixes preserve the original desktop shell while fixing mobile navigation, touch targets, composer overlap, and draft handoff.

Saved workspaces download and restore in bounded parallel batches to avoid serial per-file latency on wake.

The Linux desktop retains the upstream window manager and adds a file manager, text editor, development utilities and launcher dock. The noVNC viewer adds direct phone keyboard input and clipboard controls while retaining its native pointer handling. Hosted voice can use an optional server credential; its customer UI has no key fields.

The hosted screen gateway permits module imports from the isolated viewer origin without forwarding application credentials. Manual computer control uses the user control grant independently of an active agent run. On phones, the computer button opens the existing full-screen viewer. Hosted accounts do not expose the model API-key settings.

The paid marketing template is a separate licensed site, not a replacement application shell. Its source is retained privately; the public repository only has a routing boundary and branding.

## Complete path inventory

| Path | Classification |
| --- | --- |
| `.github/workflows/ci.yml` | Behavior and release verification |
| `.gitignore` | Adapter dependencies and build configuration |
| `apps/api/src/cloud-screen-gateway.test.ts` | Signed screen gateway isolation regression coverage |
| `apps/api/src/app.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `apps/api/src/env.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `apps/api/src/router.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `apps/api/src/voice.ts` | Optional service-supplied voice composition |
| `apps/api/src/voice.test.ts` | Voice fallback and tenant isolation coverage |
| `apps/api/src/workforce.ts` | Prior optional integration; dormant in standalone deployment |
| `apps/desktop/src/main.ts` | Shared palette applied to native startup chrome |
| `apps/desktop/src/window-options.ts` | Shared palette applied to native startup chrome |
| `apps/mobile/lib/theme.test.ts` | Shared palette regression expectation |
| `apps/mobile/app/sign-in.tsx` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/mobile/lib/api.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `apps/mobile/lib/locales/zh.ts` | Cadre branding and compiled UI labels |
| `apps/web/e2e/auth-lifecycle.spec.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/e2e/bot-crud.spec.ts` | Behavior and release verification |
| `apps/web/e2e/convex-login.spec.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/e2e/helpers.ts` | Behavior and release verification |
| `apps/web/e2e/hosted-mobile.spec.ts` | Behavior and release verification |
| `apps/web/e2e/workforce.spec.ts` | Prior optional integration; dormant in standalone deployment |
| `apps/web/index.html` | Cadre branding and compiled UI labels |
| `apps/web/public/brand/cadre-favicon.svg` | Cadre branding and compiled UI labels |
| `apps/web/public/brand/cadre-icon.svg` | Cadre branding and compiled UI labels |
| `apps/web/public/brand/cadre-mark.png` | Cadre branding and compiled UI labels |
| `apps/web/public/brand/cadre-social.png` | Cadre branding and compiled UI labels |
| `apps/web/public/site.webmanifest` | Cadre branding and compiled UI labels |
| `apps/web/src/App.tsx` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/lib/auth-capabilities.test.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/src/lib/auth-capabilities.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/src/lib/auth.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/src/lib/desktop.test.ts` | Behavior and release verification |
| `apps/web/src/lib/task-draft.ts` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/locales/de/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/en/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/es/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/hi/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/ko/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/pt-BR/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/tr/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/locales/zh-CN/messages.po` | Cadre branding and compiled UI labels |
| `apps/web/src/main.tsx` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/pages/AccountSettingsOverlay.tsx` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/src/pages/Auth.tsx` | Original local auth retained; prior optional OAuth adapter dormant |
| `apps/web/src/pages/Onboarding.tsx` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/pages/Shell.tsx` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/pages/VoiceSettingsOverlay.tsx` | Hosted voice without customer API-key fields |
| `apps/web/src/pages/Welcome.tsx` | Minimal product entry, accessibility, and responsive changes |
| `apps/web/src/pages/WorkforceOverlay.tsx` | Prior optional integration; dormant in standalone deployment |
| `apps/web/src/screen-proxy.ts` | Necessary hosted runtime and deployment adapter |
| `apps/web/src/styles.css` | Minimal product entry, accessibility, and responsive changes |
| `apps/worker/package.json` | Necessary hosted runtime and deployment adapter |
| `apps/worker/src/index.ts` | Necessary hosted runtime and deployment adapter |
| `docs/cloud-workforce.md` | Prior optional integration; dormant in standalone deployment |
| `infra/cloudflare/worker.ts` | Necessary hosted runtime and deployment adapter |
| `infra/cloudflare/wrangler.jsonc` | Necessary hosted runtime and deployment adapter |
| `infra/modal/build_image.py` | Necessary hosted runtime and deployment adapter |
| `infra/modal/computer_rpc.py` | Necessary hosted runtime and deployment adapter |
| `infra/modal/screen_gateway.py` | Necessary hosted runtime and deployment adapter |
| `infra/modal/start.sh` | Necessary hosted runtime and deployment adapter |
| `infra/render-start.mjs` | Necessary hosted runtime and deployment adapter |
| `infra/vercel-build.mjs` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/package.json` | Adapter dependencies and build configuration |
| `packages/adapters/src/cloud-storage-transport.test.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/cloud-storage.test.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/cloud-storage.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/company-os-workforce.test.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/adapters/src/company-os-workforce.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/adapters/src/executor.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `packages/adapters/src/index.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `packages/adapters/src/modal-sandbox.test.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/modal-sandbox.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/sandbox-factory.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/sandbox-provider-env.ts` | Necessary hosted runtime and deployment adapter |
| `packages/adapters/src/worker-artifacts.test.ts` | Behavior and release verification |
| `packages/auth/src/company-os.test.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/auth/src/company-os.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/auth/src/index.ts` | Original local auth retained; prior optional OAuth adapter dormant |
| `packages/contracts/src/ids.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `packages/contracts/src/index.ts` | Shared contracts or composition supporting additive hosted capabilities |
| `packages/contracts/src/workforce-status.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/contracts/src/workforce.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/core/package.json` | Adapter dependencies and build configuration |
| `packages/core/src/node/screen-proxy.ts` | Necessary hosted runtime and deployment adapter |
| `packages/db/prisma/migrations/20260905000000_cloud_workforce/migration.sql` | Prior optional integration; dormant in standalone deployment |
| `packages/db/prisma/schema.prisma` | Shared contracts or composition supporting additive hosted capabilities |
| `packages/testkit/package.json` | Adapter dependencies and build configuration |
| `packages/testkit/src/company-os-oauth.test.ts` | Prior optional integration; dormant in standalone deployment |
| `packages/ui-tokens/src/index.ts` | Minimal product entry, accessibility, and responsive changes |
| `packages/ui-tokens/src/tokens.css` | Minimal product entry, accessibility, and responsive changes |
| `packages/ui-web/src/components/ui/button.tsx` | Minimal product entry, accessibility, and responsive changes |
| `pnpm-lock.yaml` | Adapter dependencies and build configuration |
| `render.yaml` | Necessary hosted runtime and deployment adapter |
| `turbo.json` | Adapter dependencies and build configuration |
| `vercel.json` | Necessary hosted runtime and deployment adapter |
| `infra/sandboxes/computer/Dockerfile` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/embed.html` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/fluxbox.init` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/fluxbox.menu` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/start.sh` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/rakazo-browser.desktop` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/mobile-controls.js` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/tint2rc` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/supervisor/src/index.ts` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/supervisor/src/mobile-controls.test.ts` | Linux desktop applications and mobile viewer controls |
| `infra/sandboxes/computer/mobile-controls.d.ts` | Typed viewer keyboard boundary |
