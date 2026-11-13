import { useLingui } from "@lingui/react/macro";
import type { ModelSettings } from "@rakazo/contracts";
import type { ConnectionModel } from "@rakazo/core";
import { useListSearch } from "../lib/use-list-search";
import { ListSearchInput } from "./list-search-input";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Every model a connection runs; each opens its own settings. */
export function ConnectionModelList({
  models,
  onOpen,
}: {
  models: ConnectionModel[];
  onOpen: (modelId: string) => void;
}) {
  const { t } = useLingui();
  const search = useListSearch(models, {
    text: (model) => `${model.label} ${model.id}`,
    id: (model) => model.id,
  });
  const summary = (settings: ModelSettings | undefined) =>
    [
      settings?.images ? t`Images` : null,
      settings?.reasoning ? t`Thinking` : null,
      settings?.contextWindow !== undefined || settings?.maxTokens !== undefined ? t`Limits` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  if (models.length === 0) return null;
  return (
    <>
      {search.showSearch ? (
        <ListSearchInput query={search.query} setQuery={search.setQuery} />
      ) : null}
      <SettingsGroup accessibilityLabel={t`Models`} label={t`Models`}>
        {search.visible.map((model) => (
          <SettingsRow
            key={model.id}
            accessibilityRole="button"
            title={model.label}
            value={summary(model.settings)}
            chevron="right"
            onPress={() => onOpen(model.id)}
          />
        ))}
      </SettingsGroup>
    </>
  );
}
