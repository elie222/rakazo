import { useLingui } from "@lingui/react/macro";
import type { ConnectionModel } from "@rakazo/core";
import { useEffect } from "react";
import { AccessibilityInfo } from "react-native";
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
  const noMatches = models.length > 0 && search.visible.length === 0;
  const noMatchesMessage = t`No matching models`;
  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noMatches) AccessibilityInfo.announceForAccessibility(noMatchesMessage);
  }, [noMatches, noMatchesMessage]);
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
            chevron="right"
            onPress={() => onOpen(model.id)}
          />
        ))}
        {noMatches ? <SettingsRow title={noMatchesMessage} dimmed /> : null}
      </SettingsGroup>
    </>
  );
}
