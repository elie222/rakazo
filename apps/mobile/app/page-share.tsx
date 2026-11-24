import { useLingui } from "@lingui/react/macro";
import type { PageVisibility } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { NativeSymbol } from "../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../components/settings/settings-group";
import { errorText } from "../lib/api/user-error";
import { useMobileTokens } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { PageLoadFailure } from "../lib/pages/page-load-failure";
import { usePageReviewSignals } from "../lib/pages/page-review-reads";
import { pageLoadProblem } from "../lib/pages/pages";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

type ShareAction =
  | { kind: "visibility"; value: PageVisibility }
  | { kind: "add" | "revoke"; value: string };

export default function PageShareScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const pageRead = rpcQuery("pages/get", { pageId, link: true });
  const page = useScreenQuery(pageRead);
  const grantsRead = rpcQuery("pageReviews/grants", { pageId });
  const grants = useScreenQuery(grantsRead, {
    enabled: !page.isError && page.data?.visibility === "people",
  });
  usePageReviewSignals();
  useScreenHeader({ title: t`Share` });
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const save = useSave({
    save: async (action: ShareAction, send) => {
      if (action.kind === "visibility")
        await send("pages/setVisibility", { pageId, visibility: action.value });
      else if (action.kind === "add")
        await send("pageReviews/grant", { pageId, email: action.value });
      else await send("pageReviews/revoke", { pageId, grantId: action.value });
    },
    stale: [pageRead.queryKey, grantsRead.queryKey, rpcQuery("pages/get", { pageId }).queryKey],
    onSaved: (_, action) => {
      if (action.kind === "add") setEmail("");
    },
    onFailed: () => {
      void page.refetch();
      void grants.refetch();
    },
  });
  if (!page.data || (page.isError && pageLoadProblem(page.error) === "gone")) {
    return (
      <View style={styles.center}>
        {page.isPending ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : (
          <PageLoadFailure
            error={page.error}
            fallback={t`Could not load this page.`}
            gone={t`This page isn't available`}
            onRetry={() => void page.refetch()}
          />
        )}
      </View>
    );
  }
  const shown = page.isError || (save.error && page.isFetching) ? null : page.data.visibility;
  const grantsError = shown === "people" ? grants.error : null;
  const link = !save.pending && shown ? page.data.shareUrl : null;
  const owner = accountDisplay(page.data.owner, t`You`);
  const options = [
    {
      value: "private",
      title: t`Only you`,
      ios: "lock",
      android: "lock-closed-outline",
      detail:
        shown === "people"
          ? t`Removes everyone you added`
          : shown === "link"
            ? t`The shared link stops working`
            : undefined,
    },
    {
      value: "people",
      title: t`Specific people`,
      ios: "person.2",
      android: "people-outline",
      detail: shown === "link" ? t`The shared link stops working` : undefined,
    },
    {
      value: "link",
      title: t`Anyone with the link`,
      ios: "globe",
      android: "globe-outline",
      detail:
        shown === "people" ? t`Anyone can view. Removes people you added.` : t`No sign-in needed`,
    },
  ] as const;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <SettingsGroup>
        <SettingsRow title={owner.label} value={t`Owner`} />
      </SettingsGroup>
      <SettingsGroup label={t`Who can view`}>
        {options.map(({ value, title, ios, android, detail }) => (
          <SettingsRow
            key={value}
            title={title}
            detail={detail}
            accessibilityRole="radio"
            accessibilityState={{ checked: shown === value }}
            disabled={save.pending}
            leading={
              <NativeSymbol ios={ios} android={android} size={18} color={tokens.foreground} />
            }
            trailing={
              shown === value ? (
                <NativeSymbol
                  ios="checkmark"
                  android="checkmark"
                  size={16}
                  color={tokens.foreground}
                />
              ) : null
            }
            onPress={() => {
              if (shown === value) return;
              setCopied(false);
              save.run({ kind: "visibility", value });
            }}
          />
        ))}
      </SettingsGroup>
      {page.isError ? (
        <PageLoadFailure
          error={page.error}
          fallback={t`Could not load this page.`}
          onRetry={() => void page.refetch()}
        />
      ) : null}
      {shown === "people" ? (
        <SettingsGroup>
          <SettingsInputRow
            key="email"
            accessibilityLabel={t`Account email`}
            placeholder={t`Account email`}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={254}
            editable={!save.pending}
            value={email}
            onChangeText={setEmail}
          />
          <SettingsRow
            key="add"
            title={t`Add`}
            disabled={!email.trim() || save.pending}
            onPress={() => save.run({ kind: "add", value: email.trim() })}
          />
          {grants.isError
            ? null
            : grants.data?.map((person) => (
                <SettingsRow
                  key={person.id}
                  title={person.email}
                  disabled={save.pending}
                  onPress={() =>
                    Alert.alert(t`Remove access?`, person.email, [
                      { text: t`Cancel`, style: "cancel" },
                      {
                        text: t`Remove access`,
                        style: "destructive",
                        onPress: () => save.run({ kind: "revoke", value: person.id }),
                      },
                    ])
                  }
                />
              ))}
        </SettingsGroup>
      ) : null}
      {save.error || linkProblem || grantsError ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
          {linkProblem ??
            (save.error && save.input?.kind === "visibility"
              ? t`Could not change who can view this page. Try again.`
              : errorText(save.error ?? grantsError))}
        </Text>
      ) : null}
      {link &&
      (shown === "link" || (shown === "people" && !grants.isError && grants.data?.length)) ? (
        <SettingsGroup>
          <SettingsRow
            key="copy"
            title={shown === "people" ? t`Copy review link` : t`Copy link`}
            leading={
              <NativeSymbol
                ios={copied ? "checkmark" : "doc.on.doc"}
                android={copied ? "checkmark" : "copy-outline"}
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => {
              setLinkProblem(null);
              void Clipboard.setStringAsync(link).then(
                (ok) => {
                  if (ok === false) setLinkProblem(t`Could not copy the link.`);
                  else setCopied(true);
                },
                () => setLinkProblem(t`Could not copy the link.`),
              );
            }}
          />
          <SettingsRow
            key="share"
            title={t`Share`}
            leading={
              <NativeSymbol
                ios="square.and.arrow.up"
                android="share-outline"
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => {
              setLinkProblem(null);
              void Share.share(Platform.OS === "ios" ? { url: link } : { message: link }).catch(
                () => setLinkProblem(t`Something went wrong. Try again.`),
              );
            }}
          />
          {shown === "link" ? (
            <SettingsRow
              key="open"
              title={t`Open in browser`}
              leading={
                <NativeSymbol
                  ios="arrow.up.right"
                  android="open-outline"
                  size={18}
                  color={tokens.foreground}
                />
              }
              onPress={() => {
                setLinkProblem(null);
                void WebBrowser.openBrowserAsync(link).catch(() =>
                  setLinkProblem(t`Something went wrong. Try again.`),
                );
              }}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { paddingTop: 12, paddingBottom: 24 },
  error: { paddingHorizontal: 20, fontSize: 13 },
});
