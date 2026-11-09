import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { credentialForModel } from "@rakazo/core";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSelect } from "../../components/AppSelect";
import {
  connectedModelOptions,
  parseModelOptionKey,
  thinkingLevelLabel,
} from "../../lib/model-catalog";
import type { RoutineDraftState } from "../../lib/routine-draft";
import { rpc } from "../../lib/rpc";

/** The advanced popover that picks a model and thinking level for this routine. */
export function RoutineModelSettings({
  draft,
  onChange,
  fieldId,
}: {
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  fieldId: string;
}) {
  const { t } = useLingui();
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  useEffect(() => {
    void Promise.all([rpc.models.credentials(), rpc.models.list()])
      .then(([nextCredentials, nextCatalog]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
      })
      .catch(() => undefined);
  }, []);
  const modelOptions = connectedModelOptions(credentials, catalog);
  const selectedModel = draft.modelKey ? parseModelOptionKey(draft.modelKey) : null;
  const selectedEntry = selectedModel
    ? catalog.find(
        (entry) => entry.provider === selectedModel.provider && entry.id === selectedModel.modelId,
      )
    : undefined;
  const selectedCredential = credentialForModel(
    credentials,
    selectedModel?.provider,
    selectedModel?.modelId,
  );
  const thinkingOptions = (
    selectedCredential?.thinkingLevels ??
    selectedEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = selectedCredential?.thinkingLevel ?? "medium";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative ml-auto text-muted-foreground"
            aria-label={t`Advanced`}
            title={t`Advanced`}
          />
        }
      >
        <SlidersHorizontal />
        {draft.modelKey ? (
          <span
            aria-hidden
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-4">
        <label htmlFor={`${fieldId}-model`} className="block text-body text-muted-foreground">
          <Trans>Model</Trans>
          <AppSelect
            id={`${fieldId}-model`}
            className="mt-2 w-full"
            value={draft.modelKey}
            options={[
              { value: "", label: t`Bot's model` },
              ...(draft.modelKey && !modelOptions.some((option) => option.key === draft.modelKey)
                ? [{ value: draft.modelKey, label: selectedModel?.modelId ?? draft.modelKey }]
                : []),
              ...modelOptions.map((option) => ({ value: option.key, label: option.label })),
            ]}
            onValueChange={(modelKey) => onChange({ ...draft, modelKey, thinkingLevel: "" })}
          />
        </label>

        {thinkingOptions.length ? (
          <label
            htmlFor={`${fieldId}-thinking`}
            className="mt-5 block text-body text-muted-foreground"
          >
            <Trans>Thinking</Trans>
            <AppSelect
              id={`${fieldId}-thinking`}
              className="mt-2 w-full"
              value={draft.thinkingLevel}
              options={[
                {
                  value: "",
                  label: t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`,
                },
                ...thinkingOptions.map((level) => ({
                  value: level,
                  label: thinkingLevelLabel(level),
                })),
              ]}
              onValueChange={(thinkingLevel) => onChange({ ...draft, thinkingLevel })}
            />
          </label>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
