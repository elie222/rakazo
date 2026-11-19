import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionModel } from "@rakazo/core";
import { ListSearchInput, SectionHeading } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { SettingsPageHeader } from "../../components/settings/SettingsPageHeader";
import { useListSearch } from "../../lib/use-list-search";
import { SettingsListRow } from "./providers-section";

type ProviderModel = ConnectionModel;

/** One connection: its own settings, then the models that have settings of their own. */
export function ProviderPage({
  title,
  connection,
  footer,
  models,
  onBack,
  onOpenModel,
}: {
  title: string;
  /** The connection's sign-in or key controls. */
  connection: ReactNode;
  /** Rename and disconnect, after everything else. */
  footer: ReactNode;
  models: ProviderModel[];
  onBack: () => void;
  onOpenModel: (modelId: string) => void;
}) {
  const { t } = useLingui();
  const {
    query,
    setQuery,
    showSearch,
    visible: matching,
  } = useListSearch(models, {
    text: (model) => `${model.label} ${model.id}`,
    id: (model) => model.id,
  });
  return (
    <div data-testid="model-provider-page">
      <div className="mb-6">
        <SettingsPageHeader title={title} onBack={onBack} />
      </div>
      {connection}
      {models.length ? (
        <section className="mt-8" data-testid="model-provider-models">
          <SectionHeading className="mb-2.5">
            <Trans>Models</Trans>
          </SectionHeading>
          {showSearch ? (
            <div className="mb-2.5">
              <ListSearchInput
                query={query}
                setQuery={setQuery}
                label={t`Search models`}
                placeholder={t`Search`}
              />
            </div>
          ) : null}
          <ul className="divide-y divide-border rounded-xl border border-border">
            {matching.map((model) => (
              <li key={model.id}>
                <SettingsListRow
                  onClick={() => onOpenModel(model.id)}
                  label={model.label}
                  className="last:rounded-b-xl"
                />
              </li>
            ))}
            {matching.length ? null : (
              <li className="px-3 py-3 text-body text-muted-foreground">
                <Trans>No matching models</Trans>
              </li>
            )}
          </ul>
        </section>
      ) : null}
      {footer}
    </div>
  );
}
