import { isRetryableError } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { Thread } from "../components/thread/thread-screen";
import { currentApiBase, selectedSpaceId, selectSpace } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { normalizeApiBase } from "../lib/endpoint";
import { t, useI18n } from "../lib/i18n";
import { integrationsCacheScope } from "../lib/integrations-cache";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import {
  notificationOpenTarget,
  notificationTargetLink,
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notification-open";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadVerifiedIntegrationsScope,
  subscribeSessionGeneration,
} from "../lib/session";
import { errorText } from "../lib/user-error";

export default function ThreadRoute() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const [owner, setOwner] = useState<{ key: string; generation: number; userId: string } | null>(
    null,
  );
  useEffect(() => {
    if (generation !== ready) return;
    const apiBase = currentApiBase();
    let cancelled = false;
    let notified = false;
    let timer: ReturnType<typeof setTimeout>;
    const verify = () =>
      void loadVerifiedIntegrationsScope()
        .then((saved) => (saved?.apiBase === apiBase ? saved : integrationsCacheScope()))
        .then((scope) => {
          if (
            !cancelled &&
            scope &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          )
            setOwner({
              key: JSON.stringify([apiBase, scope.userId]),
              generation,
              userId: scope.userId,
            });
        })
        .catch((error) => {
          if (!cancelled && !notified) Alert.alert(t("Could not continue"), errorText(error));
          notified = true;
          if (!cancelled && isRetryableError(error)) timer = setTimeout(verify, 5_000);
        });
    verify();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [generation, ready]);
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{
    spaceId?: string | string[];
    userId?: string | string[];
    apiBase?: string | string[];
  }>();
  const { spaceId, userId, apiBase } = params;
  const requestedServer = typeof apiBase === "string" ? normalizeApiBase(apiBase) : null;
  const wrongServer =
    apiBase !== undefined && (!requestedServer?.ok || requestedServer.url !== currentApiBase());
  const currentOwner = owner?.generation === generation && generation === ready ? owner : null;
  const wrongAccount =
    wrongServer ||
    (userId !== undefined &&
      (typeof userId !== "string" || (currentOwner !== null && currentOwner.userId !== userId)));
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => selectedSpaceId());
  const [switchFailed, setSwitchFailed] = useState(false);
  const [appliedFocus, setAppliedFocus] = useState(focused);
  // Before paint, so a stacked route cannot render its thread against a space
  // a newer notification selected.
  const focusSync = threadRouteSpaceOnFocus({
    focused,
    appliedFocus,
    activeSpaceId,
    liveSpaceId: selectedSpaceId(),
    switchFailed,
  });
  if (focusSync.appliedFocus !== appliedFocus) setAppliedFocus(focusSync.appliedFocus);
  if (focusSync.activeSpaceId !== activeSpaceId) setActiveSpaceId(focusSync.activeSpaceId);
  if (focusSync.switchFailed !== switchFailed) setSwitchFailed(focusSync.switchFailed);
  const request = threadSpaceRequest(spaceId, focusSync.activeSpaceId);

  useEffect(() => {
    if (!focused || wrongAccount || !currentOwner) return;
    const next = threadSpaceRequest(spaceId, activeSpaceId);
    if (next.action === "show") {
      setSwitchFailed(false);
      return;
    }
    if (next.action === "unavailable") {
      setSwitchFailed(true);
      return;
    }
    let cancelled = false;
    setSwitchFailed(false);
    const requestedSpaceId = next.spaceId;
    void selectSpace(requestedSpaceId).then((switched) => {
      if (cancelled) return;
      // selectSpace commits the id before it resolves; a failed write rolls it back.
      if (threadSpaceSwitchResult(requestedSpaceId, switched, selectedSpaceId()) === "ready") {
        setActiveSpaceId(requestedSpaceId);
        return;
      }
      setSwitchFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, focused, spaceId, wrongAccount, currentOwner]);

  if (wrongAccount)
    return (
      <View style={styles.screen}>
        <Text style={styles.feedbackMessage}>{t("Sign in to open this notification")}</Text>
        <NativeActionButton
          label={t("Sign in")}
          onPress={() => {
            const route = notificationOpenTarget(params);
            router.replace(
              route
                ? {
                    pathname: "/notification-open",
                    params: { target: notificationTargetLink(route) },
                  }
                : "/",
            );
          }}
        />
      </View>
    );
  if (!currentOwner)
    return <ActivityIndicator accessibilityLabel={t("Loading…")} color={tokens.foreground} />;
  if (request.action === "show" && !focusSync.switchFailed)
    return (
      <View style={styles.thread}>
        <Thread key={currentOwner.key} sessionEpoch={ready} userId={currentOwner.userId} />
      </View>
    );
  return (
    <View style={styles.screen}>
      {request.action === "switch" && !focusSync.switchFailed ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <View style={styles.feedback}>
          <Text style={styles.feedbackMessage}>{t("Could not switch spaces")}</Text>
          <NativeActionButton
            label={t("Return to inbox")}
            prominence="secondary"
            onPress={() => router.replace("/")}
          />
        </View>
      )}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.background,
      gap: 12,
    },
    thread: { flex: 1 },
    feedback: { alignItems: "center", gap: 12 },
    feedbackMessage: { color: tokens.foreground, fontSize: 16 },
  });
}
