import type { ModelQuota, ModelRoleView, UsageSummary } from "@rakazo/contracts";
import { connectionDisplayName, connectionUsageGroups } from "@rakazo/contracts";
import type { ModelUsageSort, ModelUsageSortInverted } from "@rakazo/core";
import { modelUsageRoleRank, sortModelUsageEntries } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionQuota } from "../../components/connection-quota";
import { MenuPicker } from "../../components/menu-picker";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import type { MobileModel, MobileModelCredential } from "../../lib/mobile-types";
import {
  loadModelUsageSort,
  loadModelUsageSortInverted,
  saveModelUsageSort,
  saveModelUsageSortInverted,
} from "../../lib/model-usage-sort-preference";
import { native } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";

export default function Usage() {
  const { t, locale } = useI18n();
  const sideInsets = useSideInsets();
  const [credentials, setCredentials] = useState<MobileModelCredential[] | null>(null);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [failed, setFailed] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [sortOrder, setSortOrder] = useState<ModelUsageSort>("quota");
  const [sortInverted, setSortInverted] = useState<ModelUsageSortInverted>(false);
  const [mainRole, setMainRole] = useState<ModelRoleView | null>(null);
  const [approvalRole, setApprovalRole] = useState<ModelRoleView | null>(null);
  const [quotas, setQuotas] = useState<Record<string, ModelQuota>>({});
  const [quotaLoading, setQuotaLoading] = useState<Record<string, boolean>>({});
  const latestQuotaRequest = useRef<Record<string, number>>({});
  const sortChanged = useRef(false);
  const sortInvertedChanged = useRef(false);
  const loadQuota = useCallback(
    async (credentialId: string, fresh: boolean, active: () => boolean = () => true) => {
      if (!active()) return;
      const request = (latestQuotaRequest.current[credentialId] ?? 0) + 1;
      latestQuotaRequest.current[credentialId] = request;
      // Only the newest read for a connection may change what the screen shows.
      const current = () => active() && latestQuotaRequest.current[credentialId] === request;
      setQuotaLoading((loading) => ({ ...loading, [credentialId]: true }));
      try {
        const quota = await rpc("models/quota", { credentialId, fresh });
        if (current()) setQuotas((quotas) => ({ ...quotas, [credentialId]: quota }));
      } catch {
        if (current()) {
          setQuotas((quotas) => {
            const previous = quotas[credentialId];
            return {
              ...quotas,
              [credentialId]:
                previous && (previous.status === "fresh" || previous.status === "stale")
                  ? { ...previous, status: "stale" }
                  : {
                      credentialId,
                      status: "unavailable",
                      observedAt: null,
                      checkedAt: new Date().toISOString(),
                      windows: [],
                    },
            };
          });
        }
      } finally {
        if (current()) setQuotaLoading((loading) => ({ ...loading, [credentialId]: false }));
      }
    },
    [],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFailed(false);
      // A choice made while these reads are pending is newer than what they return.
      sortChanged.current = false;
      sortInvertedChanged.current = false;
      void loadModelUsageSort().then((value) => {
        if (active && !sortChanged.current) setSortOrder(value);
      });
      void loadModelUsageSortInverted().then((value) => {
        if (active && !sortInvertedChanged.current) setSortInverted(value);
      });
      void rpc("usage/summary")
        .then((value) => {
          if (active) setSummary(value);
        })
        .catch(() => {
          if (active) setSummary(null);
        });
      void Promise.all([
        rpc("models/credentials"),
        rpc("models/list").catch(() => []),
        rpc("models/role", { role: "main", scope: "account" }).catch(() => null),
        rpc("models/role", { role: "approval", scope: "account" }).catch(() => null),
      ])
        .then(([connections, models, main, approval]) => {
          if (active) {
            setCredentials(connections);
            setCatalog(models);
            setMainRole(main);
            setApprovalRole(approval);
            const ids = connectionUsageGroups(connections).map(({ credential }) => credential.id);
            setQuotas((current) =>
              Object.fromEntries(ids.flatMap((id) => (current[id] ? [[id, current[id]]] : []))),
            );
            setQuotaLoading(Object.fromEntries(ids.map((id) => [id, true])));
            void Promise.all(ids.map((id) => loadQuota(id, false, () => active)));
          }
        })
        .catch(() => {
          if (active) {
            setCredentials(null);
            setFailed(true);
          }
        });
      return () => {
        active = false;
      };
    }, [loadQuota]),
  );
  const groups = connectionUsageGroups(credentials ?? []);
  const entries = groups.map(({ credential }) => {
    const providerName =
      credential.provider === "openai-codex"
        ? "Codex"
        : credential.provider === "anthropic" && credential.authKind === "oauth"
          ? t("Claude subscription")
          : (catalog.find((entry) => entry.provider === credential.provider)?.providerName ??
            credential.provider);
    const label = connectionDisplayName(credential, providerName);
    return {
      id: credential.id,
      credential,
      label,
      quota: quotas[credential.id] ?? null,
      mainRank: modelUsageRoleRank(mainRole, credential.id, credentials ?? []),
      approvalRank: modelUsageRoleRank(approvalRole, credential.id, credentials ?? []),
    };
  });
  const sortedEntries = sortModelUsageEntries(
    entries,
    sortOrder,
    sortInverted,
    dateLocaleForUi(locale),
  );
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {summary ? (
          <SettingsGroup>
            <SettingsRow
              title={t("Usage")}
              detail={t("{runs} runs, {tokens} tokens", {
                runs: new Intl.NumberFormat(dateLocaleForUi(locale)).format(summary.runs),
                tokens:
                  summary.totalTokens == null
                    ? "—"
                    : new Intl.NumberFormat(dateLocaleForUi(locale)).format(summary.totalTokens),
              })}
            />
          </SettingsGroup>
        ) : null}
        {credentials && groups.length ? (
          <SettingsGroup>
            <MenuPicker
              label={t("Sort by")}
              value={sortOrder}
              choices={[
                { key: "main-model", label: t("Main model") },
                { key: "approval-model", label: t("Approval model") },
                { key: "quota", label: t("Remaining quota") },
                { key: "alphabetical", label: t("Alphabetical") },
              ]}
              onChange={(value) => {
                const next = value as ModelUsageSort;
                sortChanged.current = true;
                setSortOrder(next);
                void saveModelUsageSort(next);
              }}
            />
          </SettingsGroup>
        ) : null}
        {credentials && groups.length ? (
          <SettingsGroup label={t("Order")}>
            <View style={styles.segmentedControl}>
              <NativeSegmentedControl
                accessibilityLabel={t("Order")}
                value={sortInverted ? "inverted" : "normal"}
                onChange={(value) => {
                  const next = value === "inverted";
                  sortInvertedChanged.current = true;
                  setSortInverted(next);
                  void saveModelUsageSortInverted(next);
                }}
                options={[
                  {
                    value: "normal",
                    label:
                      sortOrder === "quota"
                        ? t("Most remaining")
                        : sortOrder === "alphabetical"
                          ? t("A–Z")
                          : t("Primary first"),
                  },
                  {
                    value: "inverted",
                    label:
                      sortOrder === "quota"
                        ? t("Least remaining")
                        : sortOrder === "alphabetical"
                          ? t("Z–A")
                          : t("Backups first"),
                  },
                ]}
              />
            </View>
          </SettingsGroup>
        ) : null}
        {failed ? (
          <SettingsGroup>
            <SettingsRow title={t("Could not load usage")} />
          </SettingsGroup>
        ) : null}
        {!failed && !credentials ? (
          <SettingsGroup>
            <SettingsRow title={t("Loading")} />
          </SettingsGroup>
        ) : null}
        {!failed && credentials && groups.length === 0 ? (
          <SettingsGroup>
            <SettingsRow title={t("No connected providers")} />
          </SettingsGroup>
        ) : null}
        {sortedEntries.map(({ credential, label, quota }) => {
          return (
            <ConnectionQuota
              key={credential.id}
              label={label}
              quota={quota}
              loading={quotaLoading[credential.id] ?? true}
              onRefresh={() => void loadQuota(credential.id, true)}
            />
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.groupedPage },
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 28,
  },
  segmentedControl: { paddingHorizontal: 12, paddingVertical: 8 },
});
