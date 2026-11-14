import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ModelSettings } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { ModelSettingsFields } from "@rakazo/core";
import {
  catalogEntryFor,
  connectionModels,
  credentialModelSettings,
  modelCapabilitiesConfigurable,
  modelHasOwnSettings,
  modelSettingsDefaults,
  modelSettingsFields,
  modelSettingsRequest,
} from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LimitField } from "../../components/model-connection-fields";
import { createModelsStyles } from "../../components/model-connection-styles";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import type { MobileModel, MobileModelCredential } from "../../lib/mobile-types";
import { native, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { errorText } from "../../lib/user-error";

/** One model's own settings on the connection that runs it. */
export default function ModelSettingsScreen() {
  const styles = useThemedStyles(createModelsStyles);
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useLingui();
  const {
    credentialId = "",
    modelId = "",
    spaceId,
  } = useLocalSearchParams<{
    credentialId?: string;
    modelId?: string;
    spaceId?: string;
  }>();
  const rpc = useMemo(() => settingsRpc(settingsTarget(spaceId)), [spaceId]);
  const [credential, setCredential] = useState<MobileModelCredential | null>(null);
  const [entry, setEntry] = useState<MobileModel | undefined>();
  const [fields, setFields] = useState<ModelSettingsFields | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [credentials, catalog] = await Promise.all([
      rpc("models/credentials"),
      rpc("models/list"),
    ]);
    const next = credentials.find((item) => item.id === credentialId);
    if (!next) throw new Error(t`Connection not found`);
    if (!connectionModels(next, catalog).some((entry) => entry.id === modelId)) {
      setFields(null);
      router.replace({ pathname: "/models", params: spaceId ? { spaceId } : {} });
      return;
    }
    const nextEntry = catalogEntryFor(catalog, next.provider, modelId);
    setCredential(next);
    setEntry(nextEntry);
    setFields(modelSettingsFields(credentialModelSettings(next, modelId), nextEntry));
    setError(null);
  }, [credentialId, modelId, rpc, router, spaceId, t]);

  useFocusEffect(
    useCallback(() => {
      void load().catch((err: unknown) =>
        setError(errorText(err, t`Could not load model settings`)),
      );
    }, [load, t]),
  );

  const title = entry?.label ?? modelId;
  useLayoutEffect(() => {
    if (title) navigation.setOptions({ title });
  }, [navigation, title]);

  if (!credential || !fields) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} />
        )}
      </SafeAreaView>
    );
  }

  const provider = credential.provider;
  const saved = modelSettingsFields(credentialModelSettings(credential, modelId), entry);
  const dirty = (Object.keys(fields) as (keyof ModelSettingsFields)[]).some(
    (key) => fields[key] !== saved[key],
  );
  const defaults = modelSettingsDefaults(provider, entry);
  const capabilities = modelCapabilitiesConfigurable(provider, entry);

  function update(patch: Partial<ModelSettingsFields>) {
    setFields((current) => (current ? { ...current, ...patch } : current));
    setError(null);
    setNotice(null);
  }

  function announce(next: { error?: string; notice?: string }) {
    setError(next.error ?? null);
    setNotice(next.notice ?? null);
    const message = next.error ?? next.notice;
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  async function save() {
    if (!fields || !credential) return;
    Keyboard.dismiss();
    const request = modelSettingsRequest({ fields, provider, entry });
    if (request.status === "invalid") {
      announce({
        error:
          request.field === "contextWindow"
            ? t`Enter a whole number from 1 to ${ph({ max: MAX_MODEL_CONTEXT_WINDOW })} for the context limit.`
            : request.field === "maxTokens"
              ? t`Enter a whole number from 1 to ${ph({ max: MAX_MODEL_MAX_TOKENS })} for maximum output tokens.`
              : request.field === "outputRoom"
                ? t`Maximum output tokens must be below the context limit.`
                : t`Enter a whole number from 1 to 1000 for the image limit.`,
      });
      return;
    }
    await persist(request.settings);
  }

  async function persist(settings: ModelSettings) {
    if (!credential) return;
    setPending(true);
    try {
      await rpc("models/saveModelSettings", { credentialId: credential.id, modelId, settings });
    } catch (err) {
      announce({ error: errorText(err, t`Could not save model settings`) });
      setPending(false);
      return;
    }
    try {
      await load();
      announce({ notice: t`Saved.` });
    } catch (err) {
      announce({ error: errorText(err, t`Could not load model settings`) });
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <LimitField
          label={t`Context limit`}
          value={fields.contextWindow}
          onChangeText={(contextWindow) => update({ contextWindow })}
          maxLength={String(MAX_MODEL_CONTEXT_WINDOW).length}
          placeholder={defaults.contextWindow?.toString()}
          busy={pending}
        />
        <LimitField
          label={t`Maximum output tokens`}
          value={fields.maxTokens}
          onChangeText={(maxTokens) => update({ maxTokens })}
          maxLength={String(MAX_MODEL_MAX_TOKENS).length}
          placeholder={defaults.maxTokens?.toString()}
          busy={pending}
        />
        {capabilities ? (
          <View style={[styles.card, { marginTop: 12 }]}>
            <View style={styles.modelRow}>
              <Text style={styles.modelLabel}>{t`Supports images`}</Text>
              <NativeSwitch
                accessibilityLabel={t`Supports images`}
                value={fields.images}
                onValueChange={(images) => update({ images })}
                disabled={pending}
              />
            </View>
            <View style={[styles.modelRow, styles.singleRow]}>
              <Text style={styles.modelLabel}>{t`Supports thinking`}</Text>
              <NativeSwitch
                accessibilityLabel={t`Supports thinking`}
                value={fields.reasoning}
                onValueChange={(reasoning) => update({ reasoning })}
                disabled={pending}
              />
            </View>
          </View>
        ) : null}
        {fields.images ? (
          <LimitField
            label={t`Maximum images per request`}
            value={fields.maxImagesPerPrompt}
            onChangeText={(maxImagesPerPrompt) => update({ maxImagesPerPrompt })}
            maxLength={4}
            busy={pending}
          />
        ) : null}
        {dirty ? (
          <NativeActionButton
            disabled={pending}
            label={pending ? t`Saving…` : t`Save`}
            onPress={() => void save()}
            style={{ marginTop: 12 }}
          />
        ) : null}
        {modelHasOwnSettings(credential, modelId) ? (
          <NativeActionButton
            disabled={pending}
            fill={false}
            label={t`Reset to defaults`}
            onPress={() => void persist({})}
            prominence="secondary"
            variant="text"
          />
        ) : null}
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : notice ? (
          <Text style={styles.secondary}>{notice}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
