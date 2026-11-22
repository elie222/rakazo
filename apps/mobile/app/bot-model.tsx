import { useLingui } from "@lingui/react/macro";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ModelPickerList } from "../components/models/model-picker-list";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { chatModelPickerChoices } from "../lib/models/chat-model";
import { queryClient, rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

export default function BotModelScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const focused = useIsFocused();
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  // The "Space default" row names the selected Space's model, so this read is the Space's.
  const me = useScreenQuery(rpcQuery("me"));
  const catalog = useScreenQuery(rpcQuery("models/list"));
  const credentials = useScreenQuery(rpcQuery("models/credentials"));
  const suggestions = useScreenQuery(rpcQuery("models/suggested"));
  // Finished runs change which models rank as suggested.
  useSpaceChanges(
    "runs",
    () =>
      queryClient.invalidateQueries({
        queryKey: rpcQuery("models/suggested").queryKey,
      }),
    focused,
  );
  const choices = useMemo(
    () =>
      me.data && catalog.data && credentials.data
        ? chatModelPickerChoices(me.data, catalog.data, credentials.data, value)
        : null,
    [me.data, catalog.data, credentials.data, value],
  );
  const failure = me.error ?? catalog.error ?? credentials.error;
  const error = failure && !choices ? errorText(failure, t`Could not load model settings`) : null;

  return (
    <ModelPickerList
      choices={choices}
      selectedKey={value}
      error={error}
      suggestions={suggestions.data?.suggestions}
      onSelect={(item) =>
        router.dismissTo({ pathname: "/bot-settings", params: { botId, model: item.key } })
      }
    />
  );
}
