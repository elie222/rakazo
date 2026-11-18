import type {
  Bot,
  BotAvatarSet,
  LabFeature,
  Me,
  Space,
  SpaceMemoryConfig,
} from "@rakazo/contracts";
import { parseLabs } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import type { RefObject } from "react";
import { lazyOverlay } from "../../components/ErrorBoundary";
import { setLabs } from "../../lib/bootstrap";
import { invalidateVoiceConsent } from "../../lib/calls/voice-consent";
import type { connectedAppMarks } from "../../lib/integrations/connected-apps";
import type { SpaceQueries } from "../../lib/query/query";
import { queryClient } from "../../lib/query/query";
import type { createSpaceRpc, RpcClient } from "../../lib/query/rpc";
import { FALLBACK_BOT_COLOR } from "./chat/chat-shared";
import type { ShellOverlay } from "./shell-overlay-url";

const SettingsOverlay = lazyOverlay(() =>
  import("../settings/SettingsOverlay").then((module) => module.SettingsOverlay),
);
const PeerMessagesOverlay = lazyOverlay(() =>
  import("../settings/PeerMessagesOverlay").then((module) => module.PeerMessagesOverlay),
);
const PluginsOverlay = lazyOverlay(() =>
  import("../plugins/PluginsOverlay").then((module) => module.PluginsOverlay),
);
const SkillsDialog = lazyOverlay(() =>
  import("../../components/integrations/skills-dialog").then((module) => module.SkillsDialog),
);
const BotTemplatesDialog = lazyOverlay(() =>
  import("../../components/bot-templates/bot-templates-dialog").then(
    (module) => module.BotTemplatesDialog,
  ),
);
const McpServersOverlay = lazyOverlay(() =>
  import("../integrations/McpServersOverlay").then((module) => module.McpServersOverlay),
);

/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;

function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

/** The integrations, skills, bot templates and MCP overlays the URL opens. */
export function AppOverlays({
  overlay,
  setOverlay,
  activeBotId,
  stdioEnabled,
  messagingEnabled,
  onConnectedAppsChange,
  onOpenBot,
}: {
  overlay: ShellOverlay;
  setOverlay: (next: ShellOverlay) => void;
  activeBotId: string | undefined;
  stdioEnabled: boolean;
  /** Messaging settings can be opened; a link there is shown only then. */
  messagingEnabled: boolean;
  onConnectedAppsChange: (apps: ReturnType<typeof connectedAppMarks>) => void;
  onOpenBot: (bot: Bot) => void;
}) {
  const openTemplates = () => setOverlay({ kind: "templates" });
  return (
    <>
      {overlay?.kind === "integrations" ? (
        <PluginsOverlay
          onConnectedAppsChange={onConnectedAppsChange}
          activeBotId={activeBotId}
          onClose={() => setOverlay(null)}
          onOpenMcp={() => setOverlay({ kind: "mcp" })}
          onOpenTemplates={openTemplates}
          onOpenMessaging={
            messagingEnabled
              ? () => setOverlay({ kind: "settings", section: "messaging", spaceId: null })
              : undefined
          }
        />
      ) : null}
      {overlay?.kind === "skills" ? (
        <SkillsDialog onClose={() => setOverlay(null)} onOpenTemplates={openTemplates} />
      ) : null}
      {overlay?.kind === "templates" ? (
        <BotTemplatesDialog
          onClose={() => setOverlay(null)}
          onOpenBot={(bot) => {
            setOverlay(null);
            onOpenBot(bot);
          }}
        />
      ) : null}
      {overlay?.kind === "mcp" ? (
        <McpServersOverlay
          editServerId={overlay.serverId}
          stdioEnabled={stdioEnabled}
          onClose={() => setOverlay(null)}
        />
      ) : null}
    </>
  );
}

/** Settings, opened from the URL, and a bot's conversation with another bot. */
export function SettingsOverlays({
  rpc,
  queries,
  overlay,
  setOverlay,
  settingsSpace,
  showSettings,
  spaces,
  renameSpace,
  removeSpace,
  leftSpace,
  refreshSpaces,
  openAgentImport,
  alive,
  user,
  refetchSession,
  bootstrapMe,
  setBootstrapMe,
  messagingEnabled,
  memoryConfig,
  peerConversation,
  setPeerConversation,
  active,
  peerBot,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  overlay: ShellOverlay;
  setOverlay: (next: ShellOverlay) => void;
  settingsSpace: Space | null;
  showSettings: boolean;
  spaces: Space[];
  renameSpace: (spaceId: string, name: string, client: RpcClient) => Promise<void>;
  removeSpace: (spaceId: string) => Promise<void>;
  leftSpace: (spaceId: string, activeSpaceId: string) => Promise<void>;
  refreshSpaces: () => Promise<void>;
  openAgentImport: () => void;
  alive: RefObject<boolean>;
  user: { name?: string | null; email?: string } | undefined;
  refetchSession: () => Promise<unknown>;
  bootstrapMe: Me | null | undefined;
  setBootstrapMe: (update: (prev: Me | null | undefined) => Me | null | undefined) => void;
  messagingEnabled: boolean;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  peerConversation: { peerBotId: string; peerBotName: string } | null;
  setPeerConversation: (peer: null) => void;
  active: Bot | undefined;
  peerBot: (botId: string) => { color: string; avatarSet?: BotAvatarSet } | undefined;
}) {
  const voiceStatusKey = queries.voice.status.queryKey();
  return (
    <>
      {overlay?.kind === "settings" && showSettings ? (
        <SettingsOverlay
          shellRpc={rpc}
          space={settingsSpace}
          spaces={spaces}
          onRenameSpace={renameSpace}
          onDeleteSpace={async (spaceId) => {
            await removeSpace(spaceId);
            if (alive.current) setOverlay(null);
          }}
          onLeftSpace={(spaceId, activeSpaceId) => {
            setOverlay(null);
            void leftSpace(spaceId, activeSpaceId);
          }}
          onOpenSpace={(spaceId) => setOverlay({ ...overlay, section: "space", spaceId })}
          name={user?.name ?? ""}
          onNameSaved={async () => {
            await refetchSession();
          }}
          email={user?.email}
          section={overlay.section}
          onSectionChange={(section) => setOverlay({ ...overlay, section })}
          billingEnabled={bootstrapMe?.billingEnabled === true}
          sandboxProvider={bootstrapMe?.sandboxProvider}
          computerSettingsEnabled={bootstrapMe?.computerSettingsEnabled === true}
          canConfigureComputers={bootstrapMe?.isAdmin === true}
          onSandboxProviderChange={(sandboxProvider) =>
            setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev))
          }
          messagingEnabled={messagingEnabled}
          paymentWalletProvider={bootstrapMe?.paymentWalletProvider ?? null}
          timezone={bootstrapMe?.timezone ?? null}
          onTimezoneChange={async (timezone, client) => {
            const nextMe = await client.preferences.update({ timezone });
            setBootstrapMe((prev) => (prev ? { ...prev, timezone: nextMe.timezone } : nextMe));
          }}
          botAvatarSet={bootstrapMe?.botAvatarSet}
          onBotAvatarSetChange={async (botAvatarSet) => {
            const nextMe = await rpc.preferences.update({ botAvatarSet });
            setBootstrapMe((prev) =>
              prev ? { ...prev, botAvatarSet: nextMe.botAvatarSet } : nextMe,
            );
            // Unpinned bots were restyled with it. The save already succeeded, so a failed
            // refresh only waits for the roster's next re-read.
            void refreshSpaces().catch(() => undefined);
          }}
          labs={parseLabs(bootstrapMe?.labs)}
          labsAvailable={parseLabs(bootstrapMe?.labsAvailable)}
          onLabsChange={async (labs, client) => {
            const previous = parseLabs(bootstrapMe?.labs);
            const apply = (next: LabFeature[]) => {
              setLabs(next);
              setBootstrapMe((prev) => (prev ? { ...prev, labs: next } : prev));
            };
            apply(labs);
            try {
              apply((await client.preferences.update({ labs })).labs);
            } catch (error) {
              apply(previous);
              throw error;
            }
          }}
          onAccountImported={refreshSpaces}
          onImportAgent={() => {
            setOverlay(null);
            openAgentImport();
          }}
          memoryConfig={memoryConfig}
          onMemoryConfigChange={(config) => {
            void writeSaved(queryClient, queries.memory.providerConfig.queryKey(), () => config);
          }}
          onVoiceStatusMaybeChanged={async () => {
            invalidateVoiceConsent();
            try {
              queryClient.setQueryData(
                voiceStatusKey,
                await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]),
              );
            } catch {
              // Prefer reopening Voice settings over starting a call with stale readiness.
              void queryClient.resetQueries({ queryKey: voiceStatusKey });
            }
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {peerConversation && active ? (
        <PeerMessagesOverlay
          botId={active.id}
          botName={active.name}
          botColor={active.color}
          botAvatarSet={active.avatarSet}
          peerBotId={peerConversation.peerBotId}
          peerBotName={peerConversation.peerBotName}
          peerBotColor={peerBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR}
          peerBotAvatarSet={peerBot(peerConversation.peerBotId)?.avatarSet}
          onClose={() => setPeerConversation(null)}
        />
      ) : null}
    </>
  );
}
