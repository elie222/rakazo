import { useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelHeaderRow } from "@rakazo/contracts";
import { toggleEnabledModelId } from "@rakazo/core";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { native, useThemedStyles } from "../lib/native";
import type { useListSearch } from "../lib/use-list-search";
import { HeaderRowsEditor } from "./header-rows-editor";
import { ListSearchInput } from "./list-search-input";
import { MenuPickerMenu } from "./menu-picker";
import { DisclosureRow } from "./model-connection-fields";
import { createModelsStyles } from "./model-connection-styles";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
import { Checkmark } from "./row-accessories";
import { SettingsRow } from "./settings-group";

type CompatibleEndpointFormProps = {
  busy: boolean;
  probing: boolean;
  baseUrl: string;
  onChangeBaseUrl: (next: string) => void;
  onFindModels: () => void;
  /** A known endpoint needs no setup help. */
  hasPreset: boolean;
  showEndpointHelp: boolean;
  onToggleEndpointHelp: () => void;
  apiProtocol: ModelApiProtocol;
  onChangeProtocol: (next: ModelApiProtocol) => void;
  /** The result of finding models, shown under the protocol. */
  probeFeedback: ReactNode;
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
  onFindModels,
  hasPreset,
  showEndpointHelp,
  onToggleEndpointHelp,
  apiProtocol,
  onChangeProtocol,
  probeFeedback,
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
  const effectiveBaseUrl = baseUrl.trim();
  const protocolChoices: { key: ModelApiProtocol; label: string }[] = [
    { key: "chat-completions", label: t`Chat Completions` },
    { key: "responses", label: t`Responses` },
    { key: "anthropic-messages", label: t`Anthropic Messages` },
  ];
  const apiProtocolLabel = protocolChoices.find((choice) => choice.key === apiProtocol)?.label;

  return (
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
      <NativeActionButton
        disabled={busy || probing || !effectiveBaseUrl}
        fill
        label={probing ? t`Finding…` : t`Find models`}
        onPress={onFindModels}
        prominence="secondary"
        style={{ marginTop: 12 }}
      />
      {!hasPreset ? (
        <>
          <DisclosureRow
            label={t`Setup help`}
            expanded={showEndpointHelp}
            onPress={onToggleEndpointHelp}
          />
          {showEndpointHelp ? (
            <Text
              style={styles.hint}
            >{t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}</Text>
          ) : null}
        </>
      ) : null}
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
      {probeFeedback}
      <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t`Model`}</Text>
      {/* The switches stay visible while the default is "Other model…" or a typed id. */}
      {search.showSearch ? (
        <ListSearchInput query={search.query} setQuery={search.setQuery} />
      ) : null}
      {compatibleRows.length ? (
        <View style={styles.card}>
          {search.visible.map((entry) => (
            // The switch sits beside the radio, not inside it: an accessible
            // Pressable would merge it into the row and hide it from VoiceOver.
            <View key={entry} style={styles.modelRow}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: entry === modelId }}
                disabled={probing}
                onPress={() => onSelectModel(entry)}
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
              onPress={() => onSelectModel(probeModels[0] ?? "")}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={styles.textAction}>{t`Use a found model`}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      <DisclosureRow label={t`Advanced`} expanded={showAdvanced} onPress={onToggleAdvanced} />
      {showAdvanced ? (
        <HeaderRowsEditor
          rows={headerRows}
          onChange={onChangeHeaderRows}
          disabled={busy}
          savedValuePlaceholder={savedHeaderPlaceholder}
        />
      ) : null}
    </>
  );
}
