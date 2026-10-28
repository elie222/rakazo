import { MenuView } from "@expo/ui/community/menu";
import type { BotSecretMetadata, VaultRevealed } from "@rakazo/contracts";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { VaultCredentialSheet } from "../../components/vault-credential-sheet";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";
import type { CredentialAuth, CredentialDestination } from "../../lib/vault";
import { credentialDetail, readableCredential, withCredential } from "../../lib/vault";

type ReadableCredential = BotSecretMetadata & { auth: CredentialAuth };
type CredentialAction = "show" | "replace" | "remove";

/**
 * The credentials bots can use. Opened with a Space that keeps its own vault, it edits that
 * Space's credentials instead of the account's. Show reads one value back once the person confirms
 * it's them; the value lives only in the native alert that shows it, never in this screen's state.
 */
export default function Vault() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [credentials, setCredentials] = useState<BotSecretMetadata[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // "add" opens the empty form; a credential opens it to replace that credential's value.
  const [sheet, setSheet] = useState<"add" | ReadableCredential | null>(null);
  // Counts changes, so a read that started before one never shows what it replaced.
  const changes = useRef(0);
  // A value that arrives after the screen lost focus is dropped instead of shown.
  const focused = useRef(false);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const changesAtRead = changes.current;
      void rpc("vault/list", { scope })
        .then((next) => {
          if (!current || changes.current !== changesAtRead) return;
          setCredentials(next);
          setError(null);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [attempt, rpc, scope, t]),
  );

  async function save(destination: CredentialDestination, value: string) {
    changes.current += 1;
    setError(null);
    const saved = await rpc("vault/put", { scope, destination, value });
    setCredentials((current) => withCredential(current ?? [], saved));
  }

  async function remove(name: string) {
    changes.current += 1;
    setPending(true);
    setError(null);
    try {
      await rpc("vault/remove", { scope, name });
      setCredentials((current) => current?.filter((entry) => entry.name !== name) ?? null);
    } catch (err) {
      setError(errorText(err, t("Could not remove the credential")));
    } finally {
      setPending(false);
    }
  }

  function confirmRemove(name: string) {
    Alert.alert(t("Remove {name}?", { name }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Remove"), style: "destructive", onPress: () => void remove(name) },
    ]);
  }

  async function show(name: string) {
    setPending(true);
    setError(null);
    try {
      const revealed = await withIdentityConfirmation(() => rpc("vault/reveal", { scope, name }));
      if (focused.current) showRevealed(name, revealed);
    } catch (err) {
      // Dismissing the confirmation prompt is the person's choice, not a failure.
      if (!isIdentityConfirmationRequired(err)) {
        setError(errorText(err, t("Could not show the credential")));
      }
    } finally {
      setPending(false);
    }
  }

  function showRevealed(name: string, revealed: VaultRevealed) {
    const copy = (text: string) => void Clipboard.setStringAsync(text).catch(() => undefined);
    if ("value" in revealed) {
      Alert.alert(name, revealed.value, [
        { text: t("Copy"), onPress: () => copy(revealed.value) },
        { text: t("Done"), style: "cancel" },
      ]);
      return;
    }
    Alert.alert(
      name,
      revealed.fields.map((field) => `${field.label}\n${field.value}`).join("\n\n"),
      [
        {
          text: t("Copy"),
          // A login can have more fields than an Android alert has buttons, so each gets a sheet row.
          onPress: () =>
            presentMessageActionSheet({
              title: name,
              actions: revealed.fields.map((field) => ({
                text: t("Copy {label}", { label: field.label }),
                onPress: () => copy(field.value),
              })),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
            }),
        },
        { text: t("Done"), style: "cancel" },
      ],
    );
  }

  function runAction(credential: BotSecretMetadata, action: CredentialAction) {
    if (pending) return;
    const readable = readableCredential(credential);
    if (action === "show" && readable) void show(credential.name);
    if (action === "replace" && readable) setSheet(readable);
    if (action === "remove") confirmRemove(credential.name);
  }

  const failure = error ?? loadError;
  const shownError = error ?? (credentials ? loadError : null);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {failure && !credentials ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              setAttempt((count) => count + 1);
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        {credentials ? (
          <SettingsGroup>
            {credentials.map((credential) => (
              // Each row's actions live in its menu, so another action is one more entry here.
              <MenuView
                key={credential.name}
                actions={[
                  ...(readableCredential(credential)
                    ? [
                        { id: "show", title: t("Show") },
                        { id: "replace", title: t("Replace value") },
                      ]
                    : []),
                  { id: "remove", title: t("Remove"), attributes: { destructive: true } },
                ]}
                colorScheme={colorScheme}
                onPressAction={(event) => {
                  const action = event.nativeEvent.event;
                  if (isCredentialAction(action)) runAction(credential, action);
                }}
                title={credential.name}
              >
                <SettingsRow
                  accessible
                  accessibilityRole="button"
                  dimmed={pending}
                  title={credential.name}
                  detail={credentialDetail(credential) || undefined}
                />
              </MenuView>
            ))}
            <SettingsRow
              key="add"
              accessibilityRole="button"
              disabled={pending}
              dimmed={pending}
              onPress={() => setSheet("add")}
              title={t("Add credential")}
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
      {sheet ? (
        <VaultCredentialSheet
          replacing={sheet === "add" ? null : sheet}
          onClose={() => setSheet(null)}
          onSave={save}
        />
      ) : null}
      {identityDialog}
    </SafeAreaView>
  );
}

function isCredentialAction(action: string): action is CredentialAction {
  return action === "show" || action === "replace" || action === "remove";
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
