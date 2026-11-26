import { useLingui } from "@lingui/react/macro";
import { botModelState } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ModelPickerList } from "../components/models/model-picker-list";
import { errorText } from "../lib/api/user-error";
import { rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

export default function BotModelScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  // A model missing from the connections is named from the selected Space's default.
  const me = useScreenQuery(rpcQuery("me"));
  const catalog = useScreenQuery(rpcQuery("models/list"));
  const credentials = useScreenQuery(rpcQuery("models/credentials"));
  const choices = useMemo(
    () =>
      me.data && catalog.data && credentials.data
        ? botModelState({
            credentials: credentials.data,
            catalog: catalog.data.map(localizeModelEntry),
            me: me.data,
            modelKey: value,
          }).choices
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
