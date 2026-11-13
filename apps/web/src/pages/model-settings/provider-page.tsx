import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ModelSettings } from "@rakazo/contracts";
import type { ConnectionModel } from "@rakazo/core";
import { Button, ListSearchInput, SectionHeading } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useListSearch } from "../../lib/use-list-search";

type ProviderModel = ConnectionModel;

/** The top of a page opened in place of the model list; Back returns to where it came from. */
export function ModelSettingsPageHeader({
  title,
  subtitle,
  onBack,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="mb-6 flex min-w-0 items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="-ms-2 shrink-0 text-muted-foreground"
        aria-label={t`Back`}
        onClick={onBack}
      >
        <ChevronLeft className="rtl:rotate-180" />
      </Button>
      <div className="flex min-w-0 items-baseline gap-2">
        <h3
          data-testid="model-settings-page-title"
          className="truncate text-heading3 font-medium text-foreground"
        >
          {title}
        </h3>
        {subtitle ? (
          <span className="truncate text-body-sm text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
    </div>
  );
}

/** What a model's own settings change, in a few words; nothing when it follows its card. */
function useSettingsSummary() {
  const { t } = useLingui();
  return (settings: ModelSettings | undefined) =>
    [
      settings?.images ? t`Images` : null,
      settings?.reasoning ? t`Thinking` : null,
      settings?.contextWindow !== undefined || settings?.maxTokens !== undefined ? t`Limits` : null,
    ]
      .filter(Boolean)
      .join(" · ");
}

/** One connection: its own settings, then every model it runs, each opening its settings. */
export function ProviderPage({
  title,
  connection,
  models,
  onBack,
  onOpenModel,
}: {
  title: string;
  /** The connection's name, key and disconnect controls. */
  connection: ReactNode;
  models: ProviderModel[];
  onBack: () => void;
  onOpenModel: (modelId: string) => void;
}) {
  const { t } = useLingui();
  const summary = useSettingsSummary();
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
      <ModelSettingsPageHeader title={title} onBack={onBack} />
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
                <button
                  type="button"
                  onClick={() => onOpenModel(model.id)}
                  className="flex min-h-[52px] w-full items-center gap-2.5 py-2 ps-3 pe-3 text-start outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1 truncate text-body-lg text-foreground">
                    {model.label}
                  </span>
                  {summary(model.settings) ? (
                    <span className="shrink-0 text-body-sm text-muted-foreground">
                      {summary(model.settings)}
                    </span>
                  ) : null}
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                    aria-hidden
                  />
                </button>
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
    </div>
  );
}

/** "14 models · 2 customized" for a connection's row. */
export function ProviderModelCount({ models }: { models: ProviderModel[] }) {
  const customized = models.filter((model) => model.settings).length;
  return (
    <span className="shrink-0 text-body-sm text-muted-foreground">
      <Plural value={models.length} one="# model" other="# models" />
      {customized ? (
        <>
          {" · "}
          <Plural value={customized} one="# customized" other="# customized" />
        </>
      ) : null}
    </span>
  );
}
