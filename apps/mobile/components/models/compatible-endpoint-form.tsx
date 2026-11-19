import { useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelHeaderRow } from "@rakazo/contracts";
import { isUnlistedCompatibleModel, toggleEnabledModelId } from "@rakazo/core";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { native, useThemedStyles } from "../../lib/native/native";
import type { useListSearch } from "../../lib/search/use-list-search";
import { HeaderRowsEditor } from "../integrations/header-rows-editor";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSwitch } from "../native/native-switch";
import { SettingsRow } from "../settings/settings-group";
import { ListSearchInput } from "../ui/list-search-input";
import { MenuPickerMenu } from "../ui/menu-picker";
import { Checkmark } from "../ui/row-accessories";
import { DisclosureRow } from "./model-connection-fields";
import { createModelsStyles } from "./model-connection-styles";

type CompatibleEndpointFormProps = {
  busy: boolean;
  probing: boolean;
  baseUrl: string;
  onChangeBaseUrl: (next: string) => void;
  hasPreset: boolean;
  keyField: ReactNode;
  showModelPicker: boolean;
  onToggleModelPicker: () => void;
  showConnectionOptions: boolean;
  apiProtocol: ModelApiProtocol;
  onChangeProtocol: (next: ModelApiProtocol) => void;
  probeError: string | null;
  onRetryProbe: () => void;
  search: ReturnType<typeof useListSearch<string>>;
  compatibleRows: string[];
  modelId: string;
  onSelectModel: (modelId: string) => void;
  enabledModelIds: string[];
  setEnabledModelIds: Dispatch<SetStateAction<string[]>>;
  probeModels: string[];
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  headerRows: ModelHeaderRow[];
  onChangeHeaderRows: (rows: ModelHeaderRow[]) => void;
  savedHeaderPlaceholder: (row: ModelHeaderRow) => boolean;
};

/** The server, protocol, models, and headers of an OpenAI-compatible connection. */
export function CompatibleEndpointForm({
  busy,
  probing,
  baseUrl,
  onChangeBaseUrl,
  hasPreset,
  keyField,
  showModelPicker,
  onToggleModelPicker,
  showConnectionOptions,
  apiProtocol,
  onChangeProtocol,
  probeError,
  onRetryProbe,
  search,
  compatibleRows,
  modelId,
  onSelectModel,
  enabledModelIds,
  setEnabledModelIds,
  probeModels,
  showAdvanced,
  onToggleAdvanced,
  headerRows,
  onChangeHeaderRows,
  savedHeaderPlaceholder,
}: CompatibleEndpointFormProps) {
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useLingui();
  const protocolChoices: { key: ModelApiProtocol; label: string }[] = [
    { key: "chat-completions", label: t`Chat Completions` },
    { key: "responses", label: t`Responses` },
    { key: "anthropic-messages", label: t`Anthropic Messages` },
  ];
  const apiProtocolLabel = protocolChoices.find((choice) => choice.key === apiProtocol)?.label;

  return (
    <>
      {hasPreset ? null : (
        <>
          <Text style={styles.sectionTitle}>{t`Server URL`}</Text>
          <TextInput
            accessibilityLabel={t`OpenAI-compatible server URL`}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onChangeText={onChangeBaseUrl}
            placeholder={t`http://127.0.0.1:8000/v1`}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.keyInput}
            value={baseUrl}
          />
        </>
      )}
      {keyField}
      {compatibleRows.length ? (
        <DisclosureRow label={t`Model`} expanded={showModelPicker} onPress={onToggleModelPicker} />
      ) : (
        <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t`Model`}</Text>
      )}
      {compatibleRows.includes(modelId) && !showModelPicker ? (
        <Text style={styles.secondary}>{modelId}</Text>
      ) : null}
      {showModelPicker && search.showSearch ? (
        <ListSearchInput query={search.query} setQuery={search.setQuery} />
      ) : null}
      {showModelPicker && compatibleRows.length ? (
        <View style={styles.card}>
          {search.visible.map((entry) => (
            // The switch sits beside the radio, not inside it: an accessible
            // Pressable would merge it into the row and hide it from VoiceOver.
            <View key={entry} style={styles.modelRow}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: entry === modelId }}
                disabled={probing}
                onPress={() => {
                  onSelectModel(entry);
                  onToggleModelPicker();
                }}
                style={({ pressed }) => [
                  styles.modelRowChoice,
                  probing && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.modelLabel}>{entry}</Text>
                {entry === modelId ? <Checkmark /> : null}
              </Pressable>
              <NativeSwitch
                accessibilityLabel={entry}
                value={entry === modelId || enabledModelIds.includes(entry)}
                onValueChange={(value) =>
                  setEnabledModelIds((current) => toggleEnabledModelId(current, entry, value))
                }
                disabled={busy || entry === modelId}
              />
            </View>
          ))}
          {compatibleRows.includes(modelId) ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: false }}
              disabled={probing}
              onPress={() => onSelectModel("")}
              style={({ pressed }) => [
                styles.modelRow,
                probing && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{t`Other model…`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {compatibleRows.includes(modelId) ? null : (
        <>
          <TextInput
            accessibilityLabel={t`Model id`}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && !probing}
            onChangeText={onSelectModel}
            placeholder={t`exact-model-id`}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.keyInput}
            value={modelId}
          />
          {probeModels.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onSelectModel(probeModels[0] ?? "");
              }}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={styles.textAction}>{t`Use a found model`}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      {isUnlistedCompatibleModel(modelId, probeModels) ? (
        <Text style={styles.secondary} accessibilityLiveRegion="polite">
          {t`The server didn’t list this model.`}
        </Text>
      ) : null}
      {probing ? (
        <Text style={styles.secondary} accessibilityLiveRegion="polite">{t`Finding…`}</Text>
      ) : null}
      {probeError ? (
        <>
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {probeError}
          </Text>
          <NativeActionButton
            disabled={busy}
            fill={false}
            label={t`Try again`}
            prominence="secondary"
            onPress={onRetryProbe}
          />
        </>
      ) : null}
      {showConnectionOptions ? (
        <>
          <DisclosureRow label={t`Advanced`} expanded={showAdvanced} onPress={onToggleAdvanced} />
          {showAdvanced ? (
            <>
              <MenuPickerMenu
                label={t`Protocol`}
                choices={protocolChoices}
                value={apiProtocol}
                disabled={busy}
                onChange={(value) => {
                  onChangeProtocol(value as ModelApiProtocol);
                }}
              >
                <View>
                  <SettingsRow
                    title={t`Protocol`}
                    value={apiProtocolLabel}
                    chevron="down"
                    accessibilityRole="button"
                    accessible
                    accessibilityLabel={t`Protocol`}
                    accessibilityState={{ disabled: busy }}
                    accessibilityValue={{ text: apiProtocolLabel }}
                  />
                </View>
              </MenuPickerMenu>
              <HeaderRowsEditor
                rows={headerRows}
                onChange={onChangeHeaderRows}
                disabled={busy}
                savedValuePlaceholder={savedHeaderPlaceholder}
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
