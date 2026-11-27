import { Trans, useLingui } from "@lingui/react/macro";
import { useListSearch } from "@rakazo/chat-ui/hooks";
import type { ConnectionModel } from "@rakazo/core";
import { modelOptionKey, normalizeStarredModelKeys } from "@rakazo/core";
import { Button, ListSearchInput, SectionHeading } from "@rakazo/ui-web";
import { Star } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { SettingsPageHeader } from "../../components/settings/SettingsPageHeader";
import { SettingsListRow } from "./providers-section";

type ProviderModel = ConnectionModel;

/** One connection: its own settings, then the models that have settings of their own. */
export function ProviderPage({
  title,
  provider,
  connection,
  footer,
  models,
  starredKeys,
  onToggleStar,
  onBack,
  onOpenModel,
}: {
  title: string;
  provider?: string;
  /** The connection's sign-in or key controls. */
  connection: ReactNode;
  /** Rename and disconnect, after everything else. */
  footer: ReactNode;
  models: ProviderModel[];
  starredKeys?: readonly string[];
  onToggleStar?: (key: string) => void;
  onBack: () => void;
  onOpenModel: (modelId: string) => void;
}) {
  const { t } = useLingui();
  const starredSet = useMemo(() => new Set(normalizeStarredModelKeys(starredKeys)), [starredKeys]);
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
            {matching.map((model) => {
              const starKey = provider ? modelOptionKey(provider, model.id) : null;
              const isStarred = starKey ? starredSet.has(starKey) : false;
              return (
                <li key={model.id} className="flex items-center">
                  <SettingsListRow
                    onClick={() => onOpenModel(model.id)}
                    label={model.label}
                    className="min-w-0 flex-1 last:rounded-b-xl"
                  />
                  {starKey && onToggleStar ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        isStarred
                          ? t`Remove ${model.label} from favorites`
                          : t`Add ${model.label} to favorites`
                      }
                      aria-pressed={isStarred}
                      data-starred={isStarred}
                      className={`me-2 shrink-0 ${
                        isStarred ? "text-foreground" : "text-muted-foreground/60"
                      }`}
                      onClick={() => onToggleStar(starKey)}
                    >
                      <Star
                        aria-hidden="true"
                        className={`size-4 ${isStarred ? "fill-current" : ""}`}
                      />
                    </Button>
                  ) : null}
                </li>
              );
            })}
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
