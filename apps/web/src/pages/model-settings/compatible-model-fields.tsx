import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { isUnlistedCompatibleModel, toggleEnabledModelId } from "@rakazo/core";
import {
  Button,
  Checkbox,
  Disclosure,
  Input,
  Label,
  ListSearchInput,
  OptionSelect,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { ModelHeadersEditor } from "../../components/models/ModelHeadersEditor";
import { useListSearch } from "../../lib/use-list-search";

import type { ModelSettingsState } from "./use-model-settings";

export function CompatibleModelFields({
  keyField,
  resetOpenAiCompatibleProbe,
  headerRows,
  setHeaderRows,
  savedHeaderEndpointMatches,
  credential,
  apiProtocol,
  baseUrl,
  busy,
  cancelOAuthAttempt,
  compatibleRows,
  enabledModelIds,
  endpointPreset,
  modelId,
  setModelId,
  discoverModels,
  probeError,
  probeModels,
  probing,
  selectionRevisionRef,
  setEnabledModelIds,
  setError,
  setNotice,
  updateApiProtocol,
  updateBaseUrl,
}: Pick<
  ModelSettingsState,
  | "resetOpenAiCompatibleProbe"
  | "headerRows"
  | "setHeaderRows"
  | "savedHeaderEndpointMatches"
  | "credential"
  | "apiProtocol"
  | "baseUrl"
  | "busy"
  | "cancelOAuthAttempt"
  | "compatibleRows"
  | "enabledModelIds"
  | "endpointPreset"
  | "modelId"
  | "setModelId"
  | "discoverModels"
  | "probeError"
  | "probeModels"
  | "probing"
  | "selectionRevisionRef"
  | "setEnabledModelIds"
  | "setError"
  | "setNotice"
  | "updateApiProtocol"
  | "updateBaseUrl"
> & { keyField?: ReactNode }) {
  const { t } = useLingui();
  const {
    query,
    setQuery,
    showSearch,
    visible: visibleRows,
    hiddenSelectedCount,
  } = useListSearch(compatibleRows, {
    text: (id) => id,
    id: (id) => id,
    selectedIds: [modelId, ...enabledModelIds],
  });
  const hasSearchQuery = query.trim().length > 0;
  return (
    <div className="block text-body text-muted-foreground">
      {endpointPreset ? null : (
        <label className="block" htmlFor="model-base-url">
          <Trans>Server URL</Trans>
          <Input
            id="model-base-url"
            value={baseUrl}
            onChange={(event) => updateBaseUrl(event.target.value)}
            aria-label={t`OpenAI-compatible server URL`}
            placeholder="http://127.0.0.1:8000/v1"
            autoComplete="off"
            size="lg"
            className="mt-2 text-foreground"
          />
        </label>
      )}
      {keyField}
      <div className="mt-4 block">
        <span>
          <Trans>Model</Trans>
        </span>
        {compatibleRows.includes(modelId) ? (
          <OptionSelect
            size="lg"
            className="mt-2 text-foreground"
            value={modelId}
            onValueChange={(value) => {
              cancelOAuthAttempt();
              selectionRevisionRef.current += 1;
              setModelId(value);
              setError(null);
              setNotice(null);
            }}
            aria-label={t`Models from server`}
            options={[
              ...compatibleRows.map((id) => ({ value: id, label: id })),
              { value: "", label: t`Other model…` },
            ]}
          />
        ) : (
          <Input
            value={modelId}
            onChange={(event) => {
              cancelOAuthAttempt();
              selectionRevisionRef.current += 1;
              setModelId(event.target.value);
              setError(null);
              setNotice(null);
            }}
            aria-label={t`Model id`}
            placeholder="exact-model-id"
            size="lg"
            className="mt-2 text-foreground"
          />
        )}
        {compatibleRows.length || hasSearchQuery ? (
          <Disclosure className="mt-4" summary={t`Enabled models`}>
            <div className="mt-3 grid gap-2" data-testid="compatible-model-rows">
              {showSearch ? (
                <ListSearchInput
                  query={query}
                  setQuery={setQuery}
                  label={t`Search models`}
                  placeholder={t`Search`}
                />
              ) : null}
              {hiddenSelectedCount > 0 ? (
                <p className="text-body-sm leading-[1.5] text-muted-foreground">
                  <Plural
                    value={hiddenSelectedCount}
                    one="# selected model is hidden by your search."
                    other="# selected models are hidden by your search."
                  />
                </p>
              ) : null}
              {visibleRows.map((id) => (
                <Label key={id} className="font-normal text-foreground">
                  <Checkbox
                    checked={id === modelId || enabledModelIds.includes(id)}
                    disabled={busy || id === modelId}
                    onCheckedChange={(checked) => {
                      selectionRevisionRef.current += 1;
                      setEnabledModelIds((current) => toggleEnabledModelId(current, id, checked));
                      setNotice(null);
                    }}
                  />
                  <span className="min-w-0 break-all">{id}</span>
                </Label>
              ))}
              {visibleRows.length ? null : (
                <p>
                  <Trans>No matching models</Trans>
                </p>
              )}
            </div>
          </Disclosure>
        ) : null}
        {probeModels.length && !compatibleRows.includes(modelId) ? (
          <Button
            type="button"
            variant="link"
            className="mt-2 h-auto px-0 text-body-sm leading-[1.5] text-muted-foreground underline"
            onClick={() => {
              setModelId(probeModels[0] ?? "");
            }}
          >
            <Trans>Use a found model</Trans>
          </Button>
        ) : null}
      </div>
      {isUnlistedCompatibleModel(modelId, probeModels) ? (
        <p className="mt-2 text-muted-foreground" role="status">
          <Trans>The server didn’t list this model.</Trans>
        </p>
      ) : null}
      {probing ? (
        <p className="mt-2" role="status">
          <Trans>Finding…</Trans>
        </p>
      ) : null}
      {probeError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-destructive" role="status">
            {probeError}
          </p>
          <Button type="button" variant="outline" size="xs" onClick={discoverModels}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {!endpointPreset || credential ? (
        <Disclosure className="mt-4 text-body text-muted-foreground" summary={t`Advanced`}>
          <div className="mt-4 block">
            <label className="block" htmlFor="model-protocol">
              <Trans>Protocol</Trans>
              <OptionSelect<ModelSettingsState["apiProtocol"]>
                id="model-protocol"
                size="lg"
                className="mt-2 text-foreground"
                value={apiProtocol}
                disabled={busy}
                onValueChange={(value) => {
                  selectionRevisionRef.current += 1;
                  updateApiProtocol(value);
                  setError(null);
                  setNotice(null);
                }}
                aria-label={t`Protocol`}
                options={[
                  { value: "chat-completions", label: t`Chat Completions` },
                  { value: "responses", label: t`Responses` },
                  { value: "anthropic-messages", label: t`Anthropic Messages` },
                ]}
              />
            </label>
          </div>

          <ModelHeadersEditor
            rows={headerRows}
            savedNames={savedHeaderEndpointMatches ? credential?.headerNames : []}
            disabled={busy}
            onChange={(rows) => {
              setHeaderRows(rows);
              resetOpenAiCompatibleProbe();
              setNotice(null);
            }}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
