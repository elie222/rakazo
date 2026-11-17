import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ModelPickerList } from "../components/model-picker-list";
import { chatModelPickerChoices } from "../lib/chat-model";
import { rpcQuery } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { errorText } from "../lib/user-error";

export default function BotModelScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  // The "Space default" row names the selected Space's model, so this read is the Space's.
  const me = useScreenQuery(rpcQuery("me"));
  const catalog = useScreenQuery(rpcQuery("models/list"));
  const credentials = useScreenQuery(rpcQuery("models/credentials"));
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
      onSelect={(item) =>
        router.dismissTo({ pathname: "/bot-settings", params: { botId, model: item.key } })
      }
    />
  );
}
