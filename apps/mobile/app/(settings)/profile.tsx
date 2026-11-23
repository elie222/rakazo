import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { AccountSecurity, SignInProvider } from "@rakazo/contracts";
import { accountDisplay, displayName } from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAccountDeletion } from "../../components/settings/account-deletion";
import {
  SettingsGroup,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { NameDialog } from "../../components/ui/name-dialog";
import { createAccountNameEditor } from "../../lib/account/account-name-editor";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import {
  fetchAccountSecurity,
  passwordResetCapabilities,
  updateAccountName,
} from "../../lib/auth/api-auth";
import type { MobilePasskey } from "../../lib/auth/passkey";
import {
  addPasskey,
  deletePasskey,
  listPasskeys,
  passkeysAvailable,
  renamePasskey,
} from "../../lib/auth/passkey";
import { promptPasskeyName } from "../../lib/auth/passkey-name-prompt";
import { continueWithSso } from "../../lib/auth/sso";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n/i18n";
import { useSideInsets } from "../../lib/layout/side-insets";
import { useResolvedAppearance, useThemedStyles } from "../../lib/native/native";
import { accountRpcQuery, queryClient } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { createSettingsPageStyles } from "../../lib/settings/settings-page-styles";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/settings/trusted-link-sites";

/** Who the person is and how they sign in: name, password, passkeys, trusted sites, deletion. */
export default function Profile() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const colorScheme = useResolvedAppearance();
  const [providers, setProviders] = useState<SignInProvider[]>([]);

  const meRead = accountRpcQuery("me");
  const me = useScreenQuery(meRead).data;
  const account = accountDisplay(me ?? {}, t`Your account`);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const currentName = account.label === me?.email ? "" : displayName(me?.name, "");

  const nameSaving = useRef(false);
  const { saveName, editName, closeNameDialog } = createAccountNameEditor({
    currentName,
    pending: nameSaving,
    Platform,
    Alert,
    errorText,
    updateAccountName,
    onSaved: (name) =>
      queryClient.setQueryData(meRead.queryKey, (current) => current && { ...current, name }),
    markStale: () => queryClient.invalidateQueries({ queryKey: meRead.queryKey }),
    setNameDraft,
    setNamePending,
    setNameError,
    setNameDialogOpen,
  });

  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const unlinkedProviders = security?.linkedProviderIds
    ? providers.filter((provider) => !security.linkedProviderIds?.includes(provider.id))
    : [];
  const canChangePassword = security?.hasPassword && security.passwordChangeEnabled !== false;
  const deletion = useAccountDeletion({ onSecurity: setSecurity });
  const { run: securityAction, pending } = deletion;
  const [passkeys, setPasskeys] = useState<MobilePasskey[] | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoadError, setPasskeyLoadError] = useState<string | null>(null);
  // A failed load keeps the section, with Add and a retry, instead of hiding it.
  const loadPasskeys = useCallback(async () => {
    setPasskeyLoadError(null);
    try {
      setPasskeys(await listPasskeys());
    } catch (err) {
      setPasskeys((current) => current ?? []);
      setPasskeyLoadError(errorText(err, t`Could not continue`));
    }
  }, [t]);
  const trustedSites = useTrustedLinkSites();

  useEffect(() => {
    void fetchAccountSecurity()
      .then(setSecurity)
      .catch(() => undefined);
    void passwordResetCapabilities()
      .then(async (capabilities) => {
        setProviders((capabilities.providers ?? []).filter((provider) => provider.id !== "oidc"));
        if (await passkeysAvailable(capabilities)) await loadPasskeys();
      })
      .catch(() => undefined);
  }, [loadPasskeys]);

  useFocusEffect(
    useCallback(() => {
      void loadTrustedLinkSites().catch(() => undefined);
    }, []),
  );

  async function passkeyAction(run: () => Promise<unknown>) {
    setPasskeyPending(true);
    setPasskeyError(null);
    try {
      await run();
      await loadPasskeys();
    } catch (err) {
      setPasskeyError(errorText(err, t`Could not continue`));
    } finally {
      setPasskeyPending(false);
    }
  }

  function passkeyMenuAction(passkey: MobilePasskey, name: string, action: string) {
    if (action === "rename") {
      promptPasskeyName({
        title: t`Rename`,
        cancelLabel: t`Cancel`,
        submitLabel: t`Save`,
        defaultValue: passkey.name ?? undefined,
        onSubmit: (next) => void passkeyAction(() => renamePasskey(passkey.id, next)),
      });
    } else if (action === "delete") {
      Alert.alert(t`Delete ${name}?`, undefined, [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () => void passkeyAction(() => deletePasskey(passkey.id)),
        },
      ]);
    }
  }

  function removeTrustedSite(site: string) {
    void removeTrustedLinkSite(site).catch((cause: unknown) =>
      Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t`Edit name`}
            accessibilityValue={{
              text:
                me?.email && account.label !== me.email
                  ? `${account.label}, ${me.email}`
                  : account.label,
            }}
            chevron="right"
            disabled={!me}
            detail={me?.email && account.label !== me.email ? me.email : undefined}
            prominent
            title={account.label}
            dimmed={namePending}
            onPress={editName}
          />
        </SettingsGroup>

        {(security?.sso && !security.ssoLinked) ||
        unlinkedProviders.length > 0 ||
        canChangePassword ? (
          <SettingsGroup>
            {security?.sso && !security.ssoLinked ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                dimmed={pending}
                title={t`Link ${security.sso.name === "SSO" ? t`SSO` : security.sso.name}`}
                onPress={() =>
                  void securityAction(async () => {
                    if (await continueWithSso("link")) setSecurity(await fetchAccountSecurity());
                  })
                }
              />
            ) : null}
            {unlinkedProviders.map((provider) => (
              <SettingsRow
                key={provider.id}
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                title={t`Link ${provider.name}`}
                onPress={() =>
                  void securityAction(async () => {
                    if (await continueWithSso("link", provider.id))
                      setSecurity(await fetchAccountSecurity());
                  })
                }
              />
            ))}
            {canChangePassword ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                onPress={() => router.push("/change-password")}
                title={t`Change password`}
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        {passkeys ? (
          <SettingsGroup accessibilityLabel={t`Passkeys`} label={t`Passkeys`}>
            {passkeys.map((passkey) => {
              const name = passkey.name ?? t`Passkey`;
              const created = passkey.createdAt ? new Date(passkey.createdAt) : null;
              return (
                <MenuView
                  key={passkey.id}
                  actions={[
                    // Alert.prompt, which renames, exists only on iOS.
                    ...(Platform.OS === "ios" ? [{ id: "rename", title: t`Rename` }] : []),
                    { id: "delete", title: t`Delete`, attributes: { destructive: true } },
                  ]}
                  colorScheme={colorScheme}
                  onPressAction={(event) =>
                    passkeyMenuAction(passkey, name, event.nativeEvent.event)
                  }
                  title={name}
                >
                  <SettingsRow
                    accessible
                    accessibilityRole="button"
                    detail={
                      created && !Number.isNaN(created.getTime())
                        ? created.toLocaleDateString(dateLocaleForUi(locale), {
                            dateStyle: "medium",
                          })
                        : undefined
                    }
                    dimmed={passkeyPending}
                    title={name}
                  />
                </MenuView>
              );
            })}
            <SettingsRow
              accessibilityRole="button"
              disabled={passkeyPending}
              dimmed={passkeyPending}
              onPress={() => void passkeyAction(addPasskey)}
              title={t`Add passkey`}
            />
            {passkeyLoadError ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {passkeyLoadError}
                </Text>
                <SettingsRow
                  accessibilityRole="button"
                  onPress={() => void loadPasskeys()}
                  title={t`Retry`}
                />
              </>
            ) : null}
            {passkeyError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {passkeyError}
              </Text>
            ) : null}
          </SettingsGroup>
        ) : null}

        {trustedSites.length > 0 ? (
          <SettingsGroup accessibilityLabel={t`Trusted sites`} label={t`Trusted sites`}>
            {trustedSites.map((site) => (
              <MenuView
                key={site}
                actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => removeTrustedSite(site)}
                title={site}
              >
                <SettingsRow accessible accessibilityRole="button" title={site} />
              </MenuView>
            ))}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            destructive
            dimmed={pending}
            disabled={pending}
            onPress={() => void deletion.request()}
            title={t`Delete account`}
            trailing={
              pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
            }
          />
          {deletion.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deletion.error}
            </Text>
          ) : null}
        </SettingsGroup>
      </ScrollView>
      {nameDialogOpen ? (
        <NameDialog
          draft={nameDraft}
          error={nameError}
          saving={namePending}
          onChange={(value) => {
            setNameDraft(value);
            setNameError(null);
          }}
          onSave={(value) => void saveName(value)}
          onClose={closeNameDialog}
        />
      ) : null}
      {deletion.dialog}
    </SafeAreaView>
  );
}
