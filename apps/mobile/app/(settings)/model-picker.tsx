import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ModelPickerList } from "../../components/models/model-picker-list";
import { modelPickerRequest, selectPickerModel } from "../../lib/models/model-picker-selection";
import { useScreenHeader } from "../../lib/navigation/screen-header";

export default function SettingsModelPickerScreen() {
  const { requestId = "" } = useLocalSearchParams<{ requestId?: string }>();
  const router = useRouter();
  const { t } = useLingui();
  const [request] = useState(() => modelPickerRequest(requestId));
  useScreenHeader({ title: request?.title ?? t`Model` });
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
