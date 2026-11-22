import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { credentialForModel, modelThinkingLevels } from "@rakazo/core";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import {
  Button,
  OptionSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from "@rakazo/ui-web";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { connectedModelOptions, parseModelOptionKey } from "../../../lib/models/model-catalog";
import { rpc } from "../../../lib/query/rpc";
import type { RoutineDraftState } from "../../../lib/routines/routine-draft";
import { routineDraftEventTriggered } from "../../../lib/routines/routine-draft";

/** The advanced popover that picks a model and thinking level for this routine. */
export function RoutineModelSettings({
  draft,
  onChange,
  fieldId,
  computerOffered = false,
}: {
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  fieldId: string;
  /** The viewer owns the routine and its bot and has a computer paired. */
  computerOffered?: boolean;
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
  const thinkingOptions = modelThinkingLevels(
    selectedCredential,
    selectedEntry,
    selectedModel?.modelId,
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
        {draft.modelKey || (!draft.watch && (draft.inChat || draft.useComputer)) ? (
          <span
            aria-hidden
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-4">
        <label htmlFor={`${fieldId}-model`} className="block text-body text-muted-foreground">
          <Trans>Model</Trans>
          <OptionSelect
            id={`${fieldId}-model`}
            className="mt-2"
            value={draft.modelKey}
            onValueChange={(modelKey) => onChange({ ...draft, modelKey, thinkingLevel: "" })}
            options={[
              { value: "", label: t`Bot's model` },
              ...(draft.modelKey && !modelOptions.some((option) => option.key === draft.modelKey)
                ? [{ value: draft.modelKey, label: selectedModel?.modelId ?? draft.modelKey }]
                : []),
              ...modelOptions.map((option) => ({ value: option.key, label: option.label })),
            ]}
          />
        </label>

        {thinkingOptions.length ? (
          <label
            htmlFor={`${fieldId}-thinking`}
            className="mt-5 block text-body text-muted-foreground"
          >
            <Trans>Thinking</Trans>
            <OptionSelect
              id={`${fieldId}-thinking`}
              className="mt-2"
              value={draft.thinkingLevel}
              onValueChange={(thinkingLevel) => onChange({ ...draft, thinkingLevel })}
              options={[
                { value: "", label: t`Default (${thinkingLevelLabel(defaultThinkingLevel)})` },
                ...thinkingOptions.map((level) => ({
                  value: level,
                  label: thinkingLevelLabel(level),
                })),
              ]}
            />
          </label>
        ) : null}

        {draft.watch ? null : (
          <label
            htmlFor={`${fieldId}-in-chat`}
            className="mt-5 flex items-center gap-2.5 text-body text-muted-foreground"
          >
            <Switch
              id={`${fieldId}-in-chat`}
              checked={draft.inChat}
              // A run in the chat reads the whole conversation, so it never gets the computer.
              onCheckedChange={(inChat) =>
                onChange({ ...draft, inChat, useComputer: inChat ? false : draft.useComputer })
              }
            />
            <Trans>Run in the chat</Trans>
          </label>
        )}

        {computerOffered && !draft.watch && !draft.inChat && !routineDraftEventTriggered(draft) ? (
          <label
            htmlFor={`${fieldId}-computer`}
            className="mt-5 flex items-center gap-2.5 text-body text-muted-foreground"
          >
            <Switch
              id={`${fieldId}-computer`}
              checked={draft.useComputer}
              onCheckedChange={(useComputer) => onChange({ ...draft, useComputer })}
            />
            <Trans>Use my computer</Trans>
          </label>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
