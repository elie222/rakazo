import { Stack, useRouter } from "expo-router";
import { lazy, Suspense, useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView } from "react-native";
import { cancelHeaderOptions } from "../components/sheet-header";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { captureMobileScope, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { currentReadySessionGeneration, subscribeSessionGeneration } from "../lib/session";

const NativeBotPackageImport = lazy(() =>
  import("../components/bot-package-import").then((module) => ({
    default: module.NativeBotPackageImport,
  })),
);

export default function BotPackageImportScreen() {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  const ready = useSyncExternalStore(
    subscribeSessionGeneration,
    currentReadySessionGeneration,
    currentReadySessionGeneration,
  );
  return ready === scope.sessionGeneration ? (
    <BotPackageImportEditor key={scopeKey} scope={scope} />
  ) : (
    <ActivityIndicator />
  );
}

function BotPackageImportEditor({ scope }: { scope: MobileScope }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t("Cancel"), () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Suspense fallback={<ActivityIndicator />}>
          <NativeBotPackageImport
            scope={scope}
            onClose={() => router.back()}
            onConnections={() => router.push("/integrations")}
            onOpen={(botId, botName) => {
              router.replace({ pathname: "/thread", params: { botId, name: botName } });
            }}
          />
        </Suspense>
      </ScrollView>
    </>
  );
}
