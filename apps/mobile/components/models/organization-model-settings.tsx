import { useLingui } from "@lingui/react/macro";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useThemedStyles } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { NativeActionButton } from "../native/native-action-button";
import { MenuPicker } from "../ui/menu-picker";
import { DisclosureRow } from "./model-connection-fields";
import { createModelsStyles } from "./model-connection-styles";

type Draft = { label: string; modelId: string; apiKey: string; baseUrl: string };
const emptyDraft: Draft = { label: "", modelId: "", apiKey: "", baseUrl: "" };

type Change =
  | { kind: "select"; id: string | null }
  | { kind: "remove"; id: string }
  | { kind: "create"; provider: string; draft: Draft };

export function OrganizationModelSettings({
  providers,
  spaceId,
}: {
  providers: ReadonlyArray<{ id: string; name: string; baseUrl?: string }>;
  spaceId: string;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createModelsStyles);
  const read = rpcQuery("models/organizationConnections/available", undefined, spaceId);
  const { data: view } = useScreenQuery(read);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const save = useSave({
    target: { scope: "space", spaceId },
    save: async (change: Change, send) => {
      if (change.kind === "select")
        await send("models/organizationConnections/select", { id: change.id });
      else if (change.kind === "remove")
        await send("models/organizationConnections/remove", { id: change.id });
      else
        await send("models/organizationConnections/create", {
          ...change.draft,
          baseUrl: change.draft.baseUrl || undefined,
          provider: change.provider,
        });
    },
    stale: [read.queryKey, rpcQuery("me", undefined, spaceId).queryKey],
    onSaved: (_, change) => {
      if (change.kind === "create") {
        setDraft(emptyDraft);
        setAdding(false);
      }
    },
  });
  if (!view || (!view.connections.length && !view.selectedId && !view.canManage)) return null;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const fields = [
    ...(compatible ? [{ key: "baseUrl" as const, label: t`Base URL` }] : []),
    { key: "modelId" as const, label: t`Model ID` },
    { key: "label" as const, label: t`Connection name` },
    { key: "apiKey" as const, label: t`API key` },
  ];
  return (
    <>
      {view.connections.length || view.selectedId ? (
        <View style={styles.card}>
          <MenuPicker
            label={t`Organization override for this Space`}
            value={view.selectedId ?? ""}
            placeholder={t`Unavailable organization model`}
            choices={[
              { key: "", label: t`Use saved main model` },
              ...view.connections.map((entry) => ({ key: entry.id, label: entry.label })),
            ]}
            disabled={save.pending}
            onChange={(id) => save.run({ kind: "select", id: id || null })}
          />
        </View>
      ) : null}
      {view.canManage ? (
        <>
          <DisclosureRow
            label={t`Add organization model`}
            expanded={adding}
            onPress={() => {
              if (save.pending) return;
              setDraft(emptyDraft);
              save.reset();
              setAdding(!adding);
            }}
          />
          {adding ? (
            <>
              <MenuPicker
                label={t`Provider`}
                placeholder={t`Choose a provider`}
                value={provider}
                choices={providers
                  .filter((entry) => !entry.baseUrl)
                  .map((entry) => ({ key: entry.id, label: entry.name }))}
                disabled={save.pending}
                onChange={setProvider}
              />
              {fields.map(({ key, label }) => (
                <View key={key}>
                  <Text style={styles.sectionTitle}>{label}</Text>
                  <TextInput
                    accessibilityLabel={label}
                    style={styles.keyInput}
                    value={draft[key]}
                    secureTextEntry={key === "apiKey"}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!save.pending}
                    onChangeText={(value) => setDraft({ ...draft, [key]: value })}
                  />
                </View>
              ))}
              <NativeActionButton
                label={t`Add organization model`}
                disabled={
                  save.pending ||
                  !provider ||
                  !draft.label.trim() ||
                  !draft.modelId.trim() ||
                  draft.apiKey.trim().length < 8 ||
                  (compatible && !draft.baseUrl.trim())
                }
                onPress={() => save.run({ kind: "create", draft, provider })}
              />
            </>
          ) : view.connections.length ? (
            <MenuPicker
              label={t`Remove organization model`}
              value=""
              placeholder={t`Choose a connection`}
              choices={view.connections.map((entry) => ({ key: entry.id, label: entry.label }))}
              disabled={save.pending}
              onChange={(id) => {
                const connection = view.connections.find((entry) => entry.id === id);
                if (!connection) return;
                Alert.alert(
                  t`Remove ${connection.label} for everyone in the organization?`,
                  undefined,
                  [
                    { text: t`Cancel`, style: "cancel" },
                    {
                      text: t`Remove`,
                      style: "destructive",
                      onPress: () => save.run({ kind: "remove", id }),
                    },
                  ],
                );
              }}
            />
          ) : null}
        </>
      ) : null}
      {save.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(save.error, t`Could not save organization model`)}
        </Text>
      ) : null}
    </>
  );
}
