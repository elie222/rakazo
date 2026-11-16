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
import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { formRead, queryClient, targetRpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useScreenQuery } from "../../lib/screen-query";
import type { SettingsTarget } from "../../lib/settings-target";
import { settingsTarget } from "../../lib/settings-target";
import { errorText } from "../../lib/user-error";

type ModelRoute = { credentialId: string; modelId: string; spaceId?: string };

/** The connection and the model's catalog entry, or null once the connection no longer runs the model. */
type ModelRead = { credential: MobileModelCredential; entry: MobileModel | undefined } | null;

/** The connection and the catalog as one read, so the form never shows one without the other. */
function modelRead(
  target: SettingsTarget,
  { credentialId, modelId }: ModelRoute,
  notFound: string,
) {
  const credentialsRead = targetRpcQuery(target, "models/credentials");
  const catalogRead = targetRpcQuery(target, "models/list");
  const queryFn: QueryFunction<ModelRead> = async (context) => {
    const [credentials, catalog] = await Promise.all([
      credentialsRead.queryFn(context),
      catalogRead.queryFn(context),
    ]);
    const credential = credentials.find((item) => item.id === credentialId);
    if (!credential) throw new Error(notFound);
    if (!connectionModels(credential, catalog).some((entry) => entry.id === modelId)) return null;
    return { credential, entry: catalogEntryFor(catalog, credential.provider, modelId) };
  };
  return {
    queryKey: [
      ...credentialsRead.queryKey,
      "models/list",
      credentialId,
      modelId,
    ] as unknown as DataTag<QueryKey, ModelRead, Error>,
    queryFn,
  };
}

/** One model's own settings on the connection that runs it. */
export default function ModelSettingsScreen() {
  const {
    credentialId = "",
    modelId = "",
    spaceId,
  } = useLocalSearchParams<{
    credentialId?: string;
    modelId?: string;
    spaceId?: string;
  }>();
  // Keyed by what it edits, so another model never starts from this one's unsaved edits.
  return (
    <ModelSettingsForm
      key={JSON.stringify([spaceId, credentialId, modelId])}
      credentialId={credentialId}
      modelId={modelId}
      spaceId={spaceId}
    />
  );
}

function ModelSettingsForm(route: ModelRoute) {
  const { credentialId, modelId, spaceId } = route;
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
  const { t } = useLingui();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  // Every read answers with its own object, so an edit can tell which read it was made on.
  const read = {
    ...formRead(modelRead(target, route, t`Connection not found`)),
    structuralSharing: false,
  };
  // Read again on each return to the screen. Not on app foreground: a read replaces the draft.
  const query = useScreenQuery(read, { onForeground: false });
  // A copy read before this screen opened is not what the form may start from.
  const loaded = query.isFetchedAfterMount ? query.data : undefined;
  // Edits belong to the read they were made on; the next one starts from what is saved.
  const [draft, setDraft] = useState<{ on: ModelRead; fields: ModelSettingsFields } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const readError = query.isError ? errorText(query.error, t`Could not load model settings`) : null;
  const reading = query.isFetching;
  // What a read settles as: its failure shows until an edit or a read that succeeds.
  useEffect(() => {
    if (!reading) setError(readError);
  }, [reading, readError]);

  const removed = loaded === null;
  useEffect(() => {
    if (removed) router.replace({ pathname: "/models", params: spaceId ? { spaceId } : {} });
  }, [removed, router, spaceId]);

  function announce(next: { error?: string; notice?: string }) {
    setError(next.error ?? null);
    setNotice(next.notice ?? null);
    const message = next.error ?? next.notice;
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  const change = useSave({
    target,
    save: (settings: ModelSettings, send) =>
      send("models/saveModelSettings", { credentialId, modelId, settings }),
    stale: [read.queryKey],
    onSaved: () => {
      const reread = queryClient.getQueryState(read.queryKey);
      announce(
        reread?.status === "error"
          ? { error: errorText(reread.error, t`Could not load model settings`) }
          : { notice: t`Saved.` },
      );
    },
    onFailed: (err) => announce({ error: errorText(err, t`Could not save model settings`) }),
  });
  const pending = change.pending;

  const entry = loaded?.entry;
  const title = entry?.label ?? modelId;
  useScreenHeader({ title: title || undefined });

  if (!loaded) {
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

  const shown = loaded;
  const { credential } = shown;
  const provider = credential.provider;
  const saved = modelSettingsFields(credentialModelSettings(credential, modelId), entry);
  const fields = draft?.on === shown ? draft.fields : saved;
  const dirty = (Object.keys(fields) as (keyof ModelSettingsFields)[]).some(
    (key) => fields[key] !== saved[key],
  );
  const defaults = modelSettingsDefaults(provider, entry);
  const capabilities = modelCapabilitiesConfigurable(provider, entry);

  function update(patch: Partial<ModelSettingsFields>) {
    setDraft((current) => ({
      on: shown,
      fields: { ...(current?.on === shown ? current.fields : saved), ...patch },
    }));
    setError(null);
    setNotice(null);
  }

  function save() {
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
    change.run(request.settings);
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
            onPress={save}
            style={{ marginTop: 12 }}
          />
        ) : null}
        {modelHasOwnSettings(credential, modelId) ? (
          <NativeActionButton
            disabled={pending}
            fill={false}
            label={t`Reset to defaults`}
            onPress={() => change.run({})}
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
