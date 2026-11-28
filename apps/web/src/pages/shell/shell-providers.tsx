import { VaultVariablesContext } from "@rakazo/chat-ui/web";
import type { SettingsScope } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { PageLoading } from "../../components/PageLoading";
import { useChatVaultVariables } from "../../components/vault/use-chat-vault-variables";
import type { usePagesForChat } from "../../lib/pages/pages";
import { PagesProvider } from "../../lib/pages/pages";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { InboundOriginProvider } from "../../lib/routines/inbound-url";
import type { SettingsSection } from "./shell-overlay-url";

type OpenSettings = (section: SettingsSection, spaceId: string | null, item?: string) => void;

/** What the shell's chats read from around them, once the first bot list is in. */
export function ShellProviders({
  spaceId,
  ready,
  inboundOrigin,
  pages,
  openSettings,
  children,
}: {
  spaceId: string | null;
  ready: boolean;
  inboundOrigin: string | undefined;
  pages: ReturnType<typeof usePagesForChat>;
  openSettings: OpenSettings;
  children: ReactNode;
}) {
  return (
    <SpaceRpcProvider spaceId={spaceId}>
      {ready ? (
        <InboundOriginProvider value={inboundOrigin}>
          <PagesProvider value={pages}>
            <ChatVaultVariables spaceId={spaceId} openSettings={openSettings}>
              {children}
            </ChatVaultVariables>
          </PagesProvider>
        </InboundOriginProvider>
      ) : (
        <PageLoading />
      )}
    </SpaceRpcProvider>
  );
}

function ChatVaultVariables({
  spaceId,
  openSettings,
  children,
}: {
  spaceId: string | null;
  openSettings: OpenSettings;
  children: ReactNode;
}) {
  // The shell hands a new opener each render; a steady one keeps messages from drawing again.
  const latestOpenSettings = useRef(openSettings);
  useLayoutEffect(() => {
    latestOpenSettings.current = openSettings;
  });
  // The account's Vault has its own section; a Space's own Vault is on that Space's page.
  const openVault = useCallback(
    (scope: SettingsScope, item: string) =>
      scope === "space"
        ? latestOpenSettings.current("space", spaceId, item)
        : latestOpenSettings.current("vault", null, item),
    [spaceId],
  );
  const vault = useChatVaultVariables(openVault);
  return <VaultVariablesContext.Provider value={vault}>{children}</VaultVariablesContext.Provider>;
}
