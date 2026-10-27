import { Trans, useLingui } from "@lingui/react/macro";
import {
  compatibleConnectionName,
  connectionUsageGroups,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import type { ModelUsageSort, ModelUsageSortInverted } from "@rakazo/core";
import { modelUsageRoleRank, sortModelUsageEntries } from "@rakazo/core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import {
  getModelUsageSort,
  getModelUsageSortInverted,
  setModelUsageSort,
  setModelUsageSortInverted,
  subscribeModelUsageSort,
} from "../../lib/model-usage-sort-preference";
import { useSpaceQueries } from "../../lib/query";
import { ConnectionQuota } from "./connection-quota";

export function ProviderQuotaStack({ compact = false }: { compact?: boolean }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const credentials = useQuery({ ...queries.models.credentials.queryOptions({}), retry: false });
  const catalog = useQuery({ ...queries.models.list.queryOptions({}), retry: false });
  const mainRole = useQuery({
    ...queries.models.role.queryOptions({ input: { role: "main", scope: "account" } }),
    retry: false,
  });
  const approvalRole = useQuery({
    ...queries.models.role.queryOptions({ input: { role: "approval", scope: "account" } }),
    retry: false,
  });
  const groups = connectionUsageGroups(credentials.data ?? []);
  const quotaQueries = useQueries({
    queries: groups.map(({ credential }) => ({
      ...queries.models.quota.queryOptions({ input: { credentialId: credential.id } }),
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  const order = useSyncExternalStore(
    subscribeModelUsageSort,
    getModelUsageSort,
    () => "quota" as ModelUsageSort,
  );
  const inverted = useSyncExternalStore(
    subscribeModelUsageSort,
    getModelUsageSortInverted,
    () => false as ModelUsageSortInverted,
  );
  const entries = groups.map(({ credential }, index) => {
    const providerName =
      credential.provider === "openai-codex"
        ? "Codex"
        : providerDisplayName(
            credential.provider,
            catalog.data?.find((entry) => entry.provider === credential.provider)?.providerName ??
              credential.provider,
            credential.authKind,
          );
    const label =
      credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? compatibleConnectionName(credential.baseUrl, providerName)
        : providerName;
    const accountLabel =
      credential.label.trim() && credential.label.trim() !== label
        ? credential.label.trim()
        : undefined;
    return {
      id: credential.id,
      credential,
      label,
      accountLabel,
      quota: quotaQueries[index]?.data,
      mainRank: modelUsageRoleRank(mainRole.data, credential.id, credentials.data ?? []),
      approvalRank: modelUsageRoleRank(approvalRole.data, credential.id, credentials.data ?? []),
      sortLabel: `${label} ${accountLabel ?? ""}`,
    };
  });
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const sortedEntries = sortModelUsageEntries(
    entries.map(({ sortLabel, ...entry }) => ({ ...entry, label: sortLabel })),
    order,
    inverted,
  ).flatMap(({ id }) => {
    const entry = entriesById.get(id);
    return entry ? [entry] : [];
  });
  const regularOrderLabel =
    order === "quota" ? t`Most remaining` : order === "alphabetical" ? t`A–Z` : t`Primary first`;
  const invertedOrderLabel =
    order === "quota" ? t`Least remaining` : order === "alphabetical" ? t`Z–A` : t`Backups first`;
  return (
    <div data-testid="provider-quota-stack" className="divide-y divide-border">
      {credentials.isPending ? (
        <p className="py-3 text-sm text-muted-foreground">
          <Trans>Loading</Trans>
        </p>
      ) : null}
      {credentials.isError ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          <Trans>Could not load usage</Trans>
        </p>
      ) : null}
      {credentials.isSuccess && !groups.length ? (
        <p className="py-3 text-sm text-muted-foreground">
          <Trans>No connected providers</Trans>
        </p>
      ) : null}
      {!compact && credentials.isSuccess && groups.length ? (
        <div
          data-testid="usage-sort-controls"
          className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2 sm:flex sm:justify-end"
        >
          <span className="text-sm text-muted-foreground">
            <Trans>Sort by</Trans>
          </span>
          <Select
            value={order}
            onValueChange={(value) => setModelUsageSort(value as ModelUsageSort)}
          >
            <SelectTrigger
              aria-label={t`Sort by`}
              data-testid="usage-sort-order"
              className="w-full max-w-48 sm:w-48"
            >
              <SelectValue>
                {order === "main-model"
                  ? t`Main model`
                  : order === "approval-model"
                    ? t`Approval model`
                    : order === "alphabetical"
                      ? t`Alphabetical`
                      : t`Remaining quota`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="main-model">
                <Trans>Main model</Trans>
              </SelectItem>
              <SelectItem value="approval-model">
                <Trans>Approval model</Trans>
              </SelectItem>
              <SelectItem value="quota">
                <Trans>Remaining quota</Trans>
              </SelectItem>
              <SelectItem value="alphabetical">
                <Trans>Alphabetical</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            <Trans>Order</Trans>
          </span>
          <ToggleGroup
            aria-label={t`Order`}
            data-testid="usage-sort-inversion"
            value={[inverted ? "inverted" : "normal"]}
            onValueChange={([value]) => {
              if (value) setModelUsageSortInverted(value === "inverted");
            }}
            spacing={1}
            className="rounded-lg bg-muted p-1"
          >
            <ToggleGroupItem
              value="normal"
              data-testid="usage-sort-normal"
              className="h-8 px-3 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {regularOrderLabel}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="inverted"
              data-testid="usage-sort-inverted"
              className="h-8 px-3 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {invertedOrderLabel}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}
      {sortedEntries.map(({ credential, label, accountLabel }) => {
        return (
          <div
            key={credential.id}
            data-testid={`provider-quota-${credential.id}`}
            className={`${compact ? "py-3" : "py-4"} first:pt-0 last:pb-0`}
          >
            <ConnectionQuota
              credentialId={credential.id}
              label={label}
              accountLabel={accountLabel}
              compact={compact}
            />
          </div>
        );
      })}
    </div>
  );
}
