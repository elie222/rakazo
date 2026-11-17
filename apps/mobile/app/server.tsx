import { useLingui } from "@lingui/react/macro";
import type { ModelHeaderRow } from "@rakazo/contracts";
import { serverHeadersFromRows } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useContext, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HeaderRowsEditor } from "../components/header-rows-editor";
import { LongPressMenu } from "../components/long-press-menu";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { cancelHeaderOptions, trailingHeaderOptions } from "../components/sheet-header";
import { currentApiBase } from "../lib/api";
import { resetApiBase, saveApiBase } from "../lib/api-server";
import { CallKeyboardContext } from "../lib/call-keyboard-context";
import {
  apiBaseWarning,
  defaultApiBase,
  displaySavedServer,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "../lib/endpoint";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { SavedServer } from "../lib/saved-servers";
import { removeSavedServer, savedServers } from "../lib/saved-servers";
import { serverHeaders } from "../lib/server-headers";
import { useSideInsets } from "../lib/side-insets";
import { confirmUnsentSendLoss } from "../lib/unsent-send-warning";
import { errorText } from "../lib/user-error";

export default function ServerScreen() {
  const call = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const current = currentApiBase();
  const [draft, setDraft] = useState(current);
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[]>(() =>
    Object.entries(serverHeaders(current)).map(([name, value]) => ({ name, value })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(savedServers);
  const colorScheme = useResolvedAppearance();
  const active = useRef(true);
  const saving = useRef(false);

  useEffect(() => {
    return () => {
      active.current = false;
    };
  }, []);

  function close() {
    if (!active.current) return;
    active.current = false;
    if (router.canGoBack()) router.back();
    else router.replace("/sign-in");
  }

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  // A saved server brings the headers it was set up with; typing an address uses the rows.
  async function save(target?: SavedServer) {
    if (saving.current) return;
    // Held across the confirmation, so a second submit cannot start a parallel switch.
    saving.current = true;
    try {
      setPending(true);
      setError(null);
      let headers: Record<string, string>;
      try {
        headers = target ? target.headers : serverHeadersFromRows(headerRows);
      } catch (headerError) {
        setError(errorText(headerError));
        return;
      }
      const probed = await probeApiBase(target ? target.apiBase : draft, fetch, headers);
      if (!active.current) return;
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      // Asked once the switch can happen. Only a different server clears the device; the same
      // address saves without a switch.
      if (probed.url !== current && !(await confirmUnsentSendLoss("server-switch"))) return;
      if (!active.current) return;
      const saved = await saveApiBase(probed.url, headers);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  async function forget(apiBase: string) {
    // A switch in progress records its server when it lands, which would bring this one back.
    if (saving.current) return;
    if (!(await removeSavedServer(apiBase))) {
      if (active.current) setError(t`Could not remove the server`);
      return;
    }
    if (active.current) {
      setError(null);
      setSaved(savedServers());
    }
  }

  async function restoreDefault() {
    if (saving.current) return;
    // Held across the confirmation, like save, so the two cannot run a switch in parallel.
    saving.current = true;
    try {
      if (usesCustomApiBase(current) && !(await confirmUnsentSendLoss("server-switch"))) return;
      setPending(true);
      setError(null);
      const saved = await resetApiBase();
      if (!active.current) return;
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen
        options={{
          title: t`Server`,
          ...cancelHeaderOptions(t`Cancel`, close),
          ...trailingHeaderOptions(pending ? t`Checking…` : t`Save`, () => void save(), pending),
        }}
      />
      <KeyboardAvoidingView
        enabled={!call}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={sideInsets}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            testID="server-address"
            accessibilityLabel={t`Server`}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="go"
            style={{
              backgroundColor: tokens.muted,
              borderRadius: 13,
              padding: 16,
              color: tokens.foreground,
              fontSize: 16,
            }}
            textContentType="URL"
            value={draft}
          />
          {warning ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
              {warning}
            </Text>
          ) : null}
          <HeaderRowsEditor
            rows={headerRows}
            onChange={(rows) => {
              setHeaderRows(rows);
              setError(null);
            }}
            disabled={pending}
          />
          {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
          <SettingsGroup>
            {saved
              .filter((entry) => entry.apiBase !== current)
              .map((entry) => (
                <LongPressMenu
                  key={entry.apiBase}
                  colorScheme={colorScheme}
                  title={displaySavedServer(entry.apiBase)}
                  actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                  onPressAction={() => void forget(entry.apiBase)}
                >
                  {(onLongPress) => (
                    <SettingsRow
                      accessibilityRole="button"
                      title={displaySavedServer(entry.apiBase)}
                      disabled={pending}
                      dimmed={pending}
                      onPress={() => void save(entry)}
                      onLongPress={onLongPress}
                    />
                  )}
                </LongPressMenu>
              ))}
          </SettingsGroup>
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <NativeActionButton
              disabled={pending}
              label={t`Use default server`}
              onPress={() => void restoreDefault()}
              prominence="plain"
              style={{ marginTop: 28, alignSelf: "center" }}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
