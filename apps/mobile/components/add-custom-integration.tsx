import { MenuView } from "@expo/ui/community/menu";
import type { McpSourcePreset } from "@rakazo/contracts";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { createIntegrationsStyles } from "./integrations-styles";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

export type SourceAuth = "none" | "bearer" | "header" | "oauth";
export type SourceKind = "mcp" | "api" | "graphql";
export type AddCustomOption = {
  id: string;
  label: string;
  kind: "github" | SourceKind;
  preset?: McpSourcePreset;
};

/** The Add custom button before Liquid Glass, which puts it in the header instead. */
export function AddCustomMenu({
  options,
  onSelect,
}: {
  options: AddCustomOption[];
  onSelect: (option: AddCustomOption | undefined) => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const scheme = useResolvedAppearance();
  const { t } = useI18n();
  if (iosAtLeast(26)) return null;
  return (
    <MenuView
      colorScheme={scheme}
      title={t("Add custom")}
      actions={options.map((option) => ({ id: option.id, title: option.label }))}
      onPressAction={({ nativeEvent }) =>
        onSelect(options.find((option) => option.id === nativeEvent.event))
      }
    >
      {/* A plain view: on Android the menu opens from its own Pressable, which a
          nested Pressable would take the touch from. */}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("Add custom")}
        style={styles.addCustom}
      >
        <NativeSymbol ios="plus" android="add" size={20} />
      </View>
    </MenuView>
  );
}

/** Adding a plugin from GitHub or a custom MCP, OpenAPI, or GraphQL source. */
export function AddCustomForm({
  adding,
  gitUrl,
  setGitUrl,
  onPreviewGit,
  sourceError,
  sourceKind,
  sourcePreset,
  name,
  setName,
  url,
  setUrl,
  sourceAuth,
  setSourceAuth,
  authHeader,
  setAuthHeader,
  credential,
  setCredential,
  busy,
  onAdd,
  onClose,
}: {
  adding: "github" | "source";
  gitUrl: string;
  setGitUrl: (next: string) => void;
  onPreviewGit: () => void;
  sourceError: string | null;
  sourceKind: SourceKind | null;
  sourcePreset: McpSourcePreset | null;
  name: string;
  setName: (next: string) => void;
  url: string;
  setUrl: (next: string) => void;
  sourceAuth: SourceAuth;
  setSourceAuth: (next: SourceAuth) => void;
  authHeader: string;
  setAuthHeader: (next: string) => void;
  credential: string;
  setCredential: (next: string) => void;
  busy: boolean;
  onAdd: () => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  return (
    <View style={styles.catalogStack}>
      <NativeActionButton fill={false} label={t("Back")} onPress={onClose} prominence="secondary" />
      {adding === "github" ? (
        <View testID="plugin-git-import" style={styles.card}>
          <TextInput
            value={gitUrl}
            onChangeText={setGitUrl}
            accessibilityLabel={t("Plugin GitHub URL")}
            placeholder="https://github.com/owner/plugin"
            placeholderTextColor={native.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            maxLength={2048}
            style={styles.input}
          />
          <NativeActionButton
            disabled={!gitUrl.trim()}
            label={t("Preview")}
            onPress={onPreviewGit}
            prominence="secondary"
          />
        </View>
      ) : null}
      {sourceError ? <Text style={styles.error}>{sourceError}</Text> : null}
      {adding === "source" && sourceKind ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            {sourcePreset
              ? t("Connect {name}", { name: sourcePreset.name })
              : sourceKind === "mcp"
                ? t("Remote MCP server")
                : sourceKind === "graphql"
                  ? t("GraphQL endpoint")
                  : t("OpenAPI JSON")}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("Display name")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.input}
          />
          {!sourcePreset?.url ? (
            <TextInput
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={
                sourcePreset?.urlPlaceholder ??
                (sourceKind === "mcp"
                  ? t("https://example.com/mcp")
                  : sourceKind === "graphql"
                    ? t("https://example.com/graphql")
                    : t("https://example.com/openapi.json"))
              }
              placeholderTextColor={native.tertiaryLabel}
              style={styles.input}
            />
          ) : null}
          {!sourcePreset ? (
            <MenuPicker
              label={t("Authentication")}
              plain
              value={sourceAuth}
              choices={[
                { key: "none", label: t("No auth") },
                { key: "bearer", label: t("Bearer") },
                { key: "header", label: t("API key") },
                ...(sourceKind === "mcp" ? [{ key: "oauth", label: t("OAuth") }] : []),
              ]}
              onChange={(key) => setSourceAuth(key as SourceAuth)}
            />
          ) : null}
          {sourceAuth === "header" ? (
            <TextInput
              value={authHeader}
              onChangeText={setAuthHeader}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("API key header name")}
              placeholder="x-api-key"
              placeholderTextColor={native.tertiaryLabel}
              style={styles.input}
            />
          ) : null}
          {sourceAuth === "bearer" || sourceAuth === "header" ? (
            <TextInput
              value={credential}
              onChangeText={setCredential}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={sourceAuth === "header" ? t("API key") : t("Bearer token")}
              placeholderTextColor={native.tertiaryLabel}
              style={styles.input}
            />
          ) : null}
          <View style={styles.accountActions}>
            <NativeActionButton
              busy={busy}
              label={t("Verify and add")}
              onPress={onAdd}
              prominence="secondary"
            />
            <NativeActionButton label={t("Cancel")} onPress={onClose} prominence="secondary" />
          </View>
        </View>
      ) : null}
    </View>
  );
}
