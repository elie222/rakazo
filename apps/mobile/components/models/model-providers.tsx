import type { MenuAction } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  MAX_MODEL_CONNECTION_LABEL,
  modelConnectionNames,
} from "@rakazo/contracts";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { Alert, Platform } from "react-native";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";
import { RowMenu } from "./model-role-settings";

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
  const { t } = useLingui();
  const catalogEntry = (credential: ModelCredential) =>
    catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(credential.provider),
    );
  const rows = credentials
    .map((credential) => {
      const entry = catalogEntry(credential);
      const { providerName: provider, connectionName: name } = modelConnectionNames(
        localizeModelEntry(entry ?? { provider: credential.provider }),
        credential,
      );
      return {
        credential,
        name,
        detail: credential.reconnectRequired
          ? t`Sign in again`
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
        t`Rename`,
        undefined,
        [
          { text: t`Cancel`, style: "cancel" },
          {
            text: t`Save`,
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
      Alert.alert(t`Disconnect ${name}?`, t`This removes the connection from every space.`, [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Disconnect`, style: "destructive", onPress: () => onDisconnect(credential) },
      ]);
  }

  return (
    <SettingsGroup accessibilityLabel={t`Providers`} label={t`Providers`}>
      {rows.map(({ credential, name, detail }) => {
        const actions: MenuAction[] = [
          ...(Platform.OS === "ios" ? [{ id: "rename", title: t`Rename` }] : []),
          ...(credential.authKind !== "oauth"
            ? [{ id: "manage", title: t`Replace API key` }]
            : credential.reconnectRequired
              ? [{ id: "manage", title: t`Sign in again` }]
              : []),
          { id: "disconnect", title: t`Disconnect`, attributes: { destructive: true } },
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
      <SettingsRow key="add" title={t`Add provider`} onPress={onAdd} />
    </SettingsGroup>
  );
}
