import { Trans, useLingui } from "@lingui/react/macro";
import {
  compatibleConnectionName,
  OLLAMA_CLOUD_BASE_URL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { Input } from "@rakazo/ui-web";
import { Fragment } from "react";
import { providerRowHint } from "../../lib/localized-provider-hint";

import type { ModelSettingsState } from "./use-model-settings";

export function ProviderList({
  connectedGroups,
  filteredGroups,
  otherGroups,
  providerQuery,
  setProviderQuery,
  chooseProvider,
  credentialByProvider,
  groups,
  provider,
}: Pick<
  ModelSettingsState,
  | "connectedGroups"
  | "filteredGroups"
  | "otherGroups"
  | "providerQuery"
  | "setProviderQuery"
  | "chooseProvider"
  | "credentialByProvider"
  | "groups"
  | "provider"
>) {
  const { t } = useLingui();
  function renderProviderRow(group: (typeof groups)[number], connectedSection: boolean) {
    const rowCredential = credentialByProvider.get(group.id);
    const savedModelLabel = rowCredential?.modelId
      ? (group.entries.find((entry) => entry.id === rowCredential.modelId)?.label ??
        rowCredential.modelId)
      : null;
    // Plain API-key providers show only their name; a subtitle marks the exception.
    const rowSubtitle =
      connectedSection && savedModelLabel ? savedModelLabel : providerRowHint(group.entries[0]!);
    return (
      <Fragment key={group.id}>
        <button
          type="button"
          aria-current={group.id === provider ? "true" : undefined}
          onClick={() => chooseProvider(group.id)}
          className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start last:border-0 ${
            group.id === provider ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          }`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-foreground">
              {compatibleConnectionName(rowCredential?.baseUrl, group.name)}
            </span>
            {rowSubtitle ? (
              <span className="mt-0.5 block truncate text-[12px] text-muted-foreground/80">
                {rowSubtitle}
              </span>
            ) : null}
          </span>
          {!connectedSection && rowCredential ? (
            <span className="text-[13px] leading-[1.5] text-success">
              <Trans>Connected</Trans>
            </span>
          ) : null}
        </button>
        {group.id === OPENAI_COMPATIBLE_PROVIDER_ID ? (
          <button
            type="button"
            className="w-full border-b border-border px-3.5 py-3 text-start text-[15px] hover:bg-accent/50"
            onClick={() => chooseProvider(OPENAI_COMPATIBLE_PROVIDER_ID, OLLAMA_CLOUD_BASE_URL)}
          >
            <Trans>Ollama Cloud</Trans>
          </button>
        ) : null}
      </Fragment>
    );
  }

  return (
    <div className="flex min-h-0 shrink-0 flex-col md:w-[310px]">
      <div className="mb-3 text-[13.5px] text-muted-foreground">
        <Trans>Providers</Trans>
      </div>
      <label className="sr-only" htmlFor="model-provider-search">
        <Trans>Search providers</Trans>
      </label>
      <Input
        id="model-provider-search"
        value={providerQuery}
        onChange={(event) => setProviderQuery(event.target.value)}
        placeholder={t`Search providers`}
        className="h-10 rounded-xl px-3.5"
      />
      <div className="rk-scroll mt-3 max-h-[240px] overflow-y-auto rounded-xl border border-border md:min-h-0 md:max-h-none md:flex-1">
        {filteredGroups.length ? (
          <>
            {connectedGroups.length ? (
              <>
                <p className="border-b border-border px-3.5 pb-1.5 pt-3 text-[12px] text-muted-foreground">
                  <Trans>Connected</Trans>
                </p>
                {connectedGroups.map((group) => renderProviderRow(group, true))}
                {otherGroups.length ? (
                  <p className="border-b border-border px-3.5 pb-1.5 pt-3 text-[12px] text-muted-foreground">
                    <Trans>All providers</Trans>
                  </p>
                ) : null}
              </>
            ) : null}
            {otherGroups.map((group) => renderProviderRow(group, false))}
          </>
        ) : (
          <p className="px-3.5 py-4 text-[13px] leading-[1.5] text-muted-foreground">
            <Trans>No providers found.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}
