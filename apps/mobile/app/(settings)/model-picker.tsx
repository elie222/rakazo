import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { ModelPickerList } from "../../components/model-picker-list";
import { modelPickerRequest, selectPickerModel } from "../../lib/model-picker-selection";

export default function SettingsModelPickerScreen() {
  const { requestId = "" } = useLocalSearchParams<{ requestId?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useLingui();
  const [request] = useState(() => modelPickerRequest(requestId));
  const title = request?.title ?? t`Model`;
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  return (
    <ModelPickerList
      choices={request?.choices ?? []}
      connectChoices={request?.connectChoices}
      selectedKey={request?.selectedKey ?? ""}
      providerLabel={request?.providerLabel}
      emptyMessage={request?.emptyMessage}
      error={request ? null : t`Could not load model settings`}
      onSelect={(choice) => {
        const next = selectPickerModel(requestId, choice.key);
        if (next === true) router.back();
        else if (next) router.replace(next);
      }}
    />
  );
}
