import { useLingui } from "@lingui/react/macro";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";
import { useSpaceChanges } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { presentMessageActionSheet } from "../../lib/messages/message-action-sheet";
import { useResolvedAppearance } from "../../lib/native/native";
import { refreshRpcQueries, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

export function useThreadPins(
  target: { botId?: string; groupId?: string },
  enabled: boolean,
  focused: boolean,
  jump: (messageId: string) => void,
) {
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const read = rpcQuery("threads/pins", target);
  const { data } = useScreenQuery(read, { enabled });
  useSpaceChanges("messagePins", () => refreshRpcQueries("threads/pins"), enabled && focused);
  const save = useSave<{ messageId: string; pinned: boolean }>({
    save: (input, send) => send("threads/setPin", { ...target, ...input }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(t`Could not save`, errorText(error, t`Try again.`)),
  });
  const ids = useMemo(() => data && new Set(data.map((pin) => pin.messageId)), [data]);
  const show = useCallback(() => {
    if (!data?.length) return;
    presentMessageActionSheet({
      title: t`Pinned messages`,
      colorScheme,
      cancel: t`Cancel`,
      more: t`More`,
      actions: data.map((pin) => ({
        text: pin.text || (pin.image ? t`Image` : t`Message`),
        onPress: () => jump(pin.messageId),
      })),
    });
  }, [colorScheme, data, jump, t]);
  return {
    ids: enabled && !save.pending ? ids : undefined,
    set: save.run,
    show: enabled && data?.length ? show : undefined,
  };
}
