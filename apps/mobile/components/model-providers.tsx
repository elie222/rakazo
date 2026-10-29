import type { MenuAction } from "@expo/ui/community/menu";
import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  connectionDisplayName,
  MAX_MODEL_CONNECTION_LABEL,
} from "@rakazo/contracts";
import { Alert, Platform } from "react-native";
import { useI18n } from "../lib/i18n";
import { RowMenu } from "./model-role-settings";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Every connection the account has, with the actions that act on one of them. */
export function ModelProviders({
  catalog,
  credentials,
  onManage,
  onAdd,
  onRename,
  onDisconnect,
}: {
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
  onManage: (credential: ModelCredential) => void;
  onAdd: () => void;
  onRename: (credential: ModelCredential, label: string) => void;
  onDisconnect: (credential: ModelCredential) => void;
}) {
  const { t } = useI18n();
  const providerName = (credential: ModelCredential) =>
    catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(credential.provider),
    )?.providerName ?? credential.provider;
  const rows = credentials
    .map((credential) => {
      const provider = providerName(credential);
      const name = connectionDisplayName(credential, provider);
      return {
        credential,
        name,
        detail: credential.reconnectRequired
          ? t("Sign in again")
          : name.startsWith(provider)
            ? undefined
            : provider,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  function act(credential: ModelCredential, name: string, id: string) {
    if (id === "manage") onManage(credential);
    else if (id === "rename")
      // Alert.prompt, which renames, exists only on iOS.
      Alert.prompt(
        t("Rename"),
        undefined,
        [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Save"),
            onPress: (value?: string) => {
              const label = value?.trim().slice(0, MAX_MODEL_CONNECTION_LABEL);
              if (label && label !== credential.label) onRename(credential, label);
            },
          },
        ],
        "plain-text",
        credential.label,
      );
    else if (id === "disconnect")
      Alert.alert(
        t("Disconnect {name}?", { name }),
        t("This removes the connection from every space."),
        [
          { text: t("Cancel"), style: "cancel" },
          { text: t("Disconnect"), style: "destructive", onPress: () => onDisconnect(credential) },
        ],
      );
  }

  return (
    <SettingsGroup accessibilityLabel={t("Providers")} label={t("Providers")}>
      {rows.map(({ credential, name, detail }) => {
        const actions: MenuAction[] = [
          ...(Platform.OS === "ios" ? [{ id: "rename", title: t("Rename") }] : []),
          {
            id: "manage",
            title: credential.authKind === "oauth" ? t("Sign in again") : t("Replace API key"),
          },
          { id: "disconnect", title: t("Disconnect"), attributes: { destructive: true } },
        ];
        return (
          <RowMenu
            key={credential.id}
            title={name}
            actions={actions}
            onAction={(id) => act(credential, name, id)}
          >
            <SettingsRow
              accessibilityRole="button"
              title={name}
              detail={detail}
              chevron="right"
              onPress={() => onManage(credential)}
              accessibilityActions={actions.map((action) => ({
                name: action.id ?? action.title,
                label: action.title,
              }))}
              onAccessibilityAction={({ nativeEvent }) =>
                act(credential, name, nativeEvent.actionName)
              }
            />
          </RowMenu>
        );
      })}
      <SettingsRow key="add" title={t("Add provider")} onPress={onAdd} />
    </SettingsGroup>
  );
}
