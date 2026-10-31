import type { ModelQuota, ModelRoleView, UsageSummary } from "@rakazo/contracts";
import { connectionDisplayName, connectionUsageGroups } from "@rakazo/contracts";
import type { ModelUsageSort, ModelUsageSortInverted } from "@rakazo/core";
import { modelUsageRoleRank, sortModelUsageEntries } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionQuota } from "../../components/connection-quota";
import { MenuPicker } from "../../components/menu-picker";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import type { MobileModel, MobileModelCredential } from "../../lib/api";
import { rpc } from "../../lib/api";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import {
  loadModelUsageSort,
  loadModelUsageSortInverted,
  saveModelUsageSort,
  saveModelUsageSortInverted,
} from "../../lib/model-usage-sort-preference";
import { native } from "../../lib/native";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
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
  const loadQuota = useCallback(
    async (credentialId: string, active: () => boolean = () => true) => {
      if (!active()) return;
      setQuotaLoading((current) => ({ ...current, [credentialId]: true }));
      try {
        const quota = await rpc("models/quota", { credentialId, fresh: true });
        if (active()) setQuotas((current) => ({ ...current, [credentialId]: quota }));
      } catch {
        if (active()) {
          setQuotas((current) => {
            const previous = current[credentialId];
            return {
              ...current,
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
        if (active()) setQuotaLoading((current) => ({ ...current, [credentialId]: false }));
      }
    },
    [],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFailed(false);
      void loadModelUsageSort().then((value) => {
        if (active) setSortOrder(value);
      });
      void loadModelUsageSortInverted().then((value) => {
        if (active) setSortInverted(value);
      });
      void rpc("usage/summary")
        .then((value) => {
          if (active) setSummary(value);
        })
        .catch(() => undefined);
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
            setQuotas({});
            setQuotaLoading(Object.fromEntries(ids.map((id) => [id, true])));
            void Promise.all(ids.map((id) => loadQuota(id, () => active)));
          }
        })
        .catch(() => {
          if (active) setFailed(true);
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
          ? "Claude subscription"
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
              credentialId={credential.id}
              target={ACCOUNT_SETTINGS}
              label={label}
              readOnly
              quotaOverride={quota}
              quotaLoading={quotaLoading[credential.id] ?? true}
              onRefreshQuota={() => void loadQuota(credential.id)}
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
