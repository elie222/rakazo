import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { isRetryableError } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Thread } from "../components/thread/thread-screen";
import { currentApiBase, selectedSpaceId } from "../lib/api/api";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadVerifiedScope,
  subscribeSessionGeneration,
} from "../lib/api/session";
import { errorText } from "../lib/api/user-error";
import { verifiedScope } from "../lib/api/verified-scope";
import { useMobileTokens } from "../lib/native/native";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notifications/notification-open";
import { selectSpaceAcrossOrganizations } from "../lib/spaces/organizations";

type ThreadOwner = { key: string; generation: number; userId: string; apiBase: string };

/** The account the last chat confirmed, so a chat opened later in the same session draws at once. */
let confirmedOwner: ThreadOwner | null = null;

export default function ThreadRoute() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const [owner, setOwner] = useState<ThreadOwner | null>(() =>
    confirmedOwner?.generation === generation &&
    generation === ready &&
    confirmedOwner.apiBase === currentApiBase()
      ? confirmedOwner
      : null,
  );
  useEffect(() => {
    if (generation !== ready) return;
    const apiBase = currentApiBase();
    let cancelled = false;
    let notified = false;
    let timer: ReturnType<typeof setTimeout>;
    const verify = () =>
      void loadVerifiedScope()
        .then((saved) => (saved?.apiBase === apiBase ? saved : verifiedScope()))
        .then((scope) => {
          if (
            !cancelled &&
            scope &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          )
            setOwner((current) => {
              const next = {
                key: JSON.stringify([apiBase, scope.userId]),
                generation,
                userId: scope.userId,
                apiBase,
              };
              confirmedOwner = next;
              return current?.key === next.key && current.generation === generation
                ? current
                : next;
            });
        })
        .catch((error) => {
          if (!cancelled && !notified) Alert.alert(t`Could not continue`, errorText(error));
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
  const { t } = useLingui();
  const router = useRouter();
  const focused = useIsFocused();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
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
    if (!focused) return;
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
    void selectSpaceAcrossOrganizations(requestedSpaceId).then((switched) => {
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
  }, [activeSpaceId, focused, spaceId]);

  if (request.action === "show" && !focusSync.switchFailed)
    return (
      <>
        {owner?.generation !== generation ? <ActivityIndicator color={tokens.foreground} /> : null}
        <View style={{ flex: 1, display: owner?.generation === generation ? "flex" : "none" }}>
          {owner ? <Thread key={owner.key} sessionEpoch={ready} userId={owner.userId} /> : null}
        </View>
      </>
    );
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {request.action === "switch" && !focusSync.switchFailed ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <View style={{ alignItems: "center", gap: 12 }}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>
            {t`Could not switch spaces`}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
            <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t`Return to inbox`}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
