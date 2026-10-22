import type { ChatModelChoice } from "@rakazo/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ModelPickerList } from "../components/model-picker-list";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { chatModelPickerChoices } from "../lib/chat-model";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";

export default function BotModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([me, catalog, credentials]) =>
        setChoices(chatModelPickerChoices(me, catalog, credentials, value, t)),
      )
      .catch((err) => setError(errorText(err, t("Could not load model settings"))));
  }, [t, value]);

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
