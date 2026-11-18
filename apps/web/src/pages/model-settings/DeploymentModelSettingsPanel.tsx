import { Trans, useLingui } from "@lingui/react/macro";
import type { SharedModelInput } from "@rakazo/contracts";
import { Button, Input, OptionSelect, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../../lib/query/query";

export function DeploymentModelSettingsPanel({
  providerLabel,
  onConnected,
}: {
  providerLabel: (provider: string) => string;
  onConnected?: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const query = queries.models.sharedDeployment.queryOptions();
  const { data, isError } = useQuery(query);
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState<SharedModelInput["method"] | null>(null);
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [binding, setBinding] = useState("");
  const choice = data?.providers.find((entry) => entry.id === provider);
  const save = useSave({
    save: (input: SharedModelInput | null, rpc) => rpc.models.setSharedDeployment(input),
    stale: [query.queryKey, queries.models.role.key(), queries.me.queryKey()],
    onSaved: (_saved, input) => {
      if (input) onConnected?.();
      setApiKey("");
      setEditing(false);
      setDisconnecting(false);
    },
  });

  return (
    <section aria-label={t`Deployment default`} className="space-y-3">
      <SectionHeading variant="heading">
        <Trans>Deployment default</Trans>
      </SectionHeading>
      {isError ? (
        <p role="alert">
          <Trans>Could not load the deployment model.</Trans>
        </p>
      ) : null}
      {data?.connection ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="break-all text-body-sm">
            <span>{providerLabel(data.connection.provider)}</span>
            <span className="block text-muted-foreground">{data.connection.modelId}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={save.pending}
            onClick={() => setDisconnecting(true)}
          >
            <Trans>Disconnect</Trans>
          </Button>
        </div>
      ) : null}
      {data?.providers.length && !editing ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {data.connection ? <Trans>Edit connection</Trans> : <Trans>Connect provider</Trans>}
        </Button>
      ) : null}
      {data?.providers.length && editing ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const model = modelId.trim();
            if (!provider || !method || !model) return;
            const base = { provider, modelId: model };
            if (method === "api_key") save.run({ ...base, method, apiKey });
            else save.run({ ...base, method, binding });
          }}
        >
          <OptionSelect
            value={provider || null}
            aria-label={t`Provider`}
            options={data.providers.map(({ id }) => ({ value: id, label: providerLabel(id) }))}
            onValueChange={(next) => {
              setProvider(next);
              setMethod(data.providers.find((entry) => entry.id === next)?.methods[0] ?? null);
              setApiKey("");
              setBinding("");
              setModelId("");
            }}
          />
          {choice ? (
            <>
              <OptionSelect
                value={method}
                aria-label={t`Authentication`}
                options={choice.methods.map((type) => ({
                  value: type,
                  label: type === "api_key" ? t`API key` : t`OAuth`,
                }))}
                onValueChange={setMethod}
              />
              <Input
                aria-label={t`Model ID`}
                placeholder={t`Model ID`}
                required
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
              {method === "api_key" ? (
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={t`API key`}
                  placeholder={t`API key`}
                  value={apiKey}
                  required
                  onChange={(event) => setApiKey(event.target.value)}
                />
              ) : (
                <OptionSelect
                  value={binding || null}
                  aria-label={t`Workload identity`}
                  options={choice.bindings.map((name) => ({ value: name, label: name }))}
                  onValueChange={setBinding}
                />
              )}
              <Button
                type="submit"
                size="sm"
                className="justify-self-start"
                disabled={
                  save.pending ||
                  !modelId.trim() ||
                  (method === "api_key" ? !apiKey.trim() : !binding)
                }
              >
                <Trans>Test and save</Trans>
              </Button>
            </>
          ) : null}
        </form>
      ) : null}
      {disconnecting ? (
        <ConfirmDialog
          title={<Trans>Disconnect the deployment model?</Trans>}
          description={<Trans>Runs that use it will return to the server configuration.</Trans>}
          onCancel={() => setDisconnecting(false)}
          confirmLabel={<Trans>Disconnect</Trans>}
          onConfirm={() => save.run(null)}
          busy={save.pending}
          error={save.error instanceof Error ? save.error.message : undefined}
        />
      ) : null}
      {save.error && !disconnecting ? (
        <p role="alert" className="text-body-sm text-destructive">
          {save.error instanceof Error
            ? save.error.message
            : t`Could not save the deployment model.`}
        </p>
      ) : null}
    </section>
  );
}
