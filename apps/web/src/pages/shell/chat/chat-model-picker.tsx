import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatModelChoice, ModelMark } from "@rakazo/core";
import { groupModelChoices, modelChoiceSearchText, modelMark } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { ModelMarkIcon } from "../../../components/models/ModelMarkIcon";
import { TextOnlyMark } from "../../../components/models/TextOnlyMark";
import { useListSearch } from "../../../lib/use-list-search";

/**
 * A bot's model as one settings row, or as a small button in the message box (`compact`): either
 * names the model in use and opens the list.
 */
export function ChatModelPicker({
  id,
  choices,
  value,
  onChange,
  compact = false,
  selectedLabel,
  mark,
  detail,
  aside,
  staysOpen,
  onConnect,
  disabled,
}: {
  id?: string;
  choices: readonly ChatModelChoice[];
  value: string;
  onChange: (key: string) => void;
  compact?: boolean;
  /** What the button calls the selected choice, when that differs from its row in the list. */
  selectedLabel?: string;
  /** The selected model's maker, marked on the compact button. */
  mark?: ModelMark;
  /** Shown after the model on the compact button, such as its thinking level. */
  detail?: string;
  /** More of the model's settings beside the list (`compact` only); `close` shuts the panel. */
  aside?: (close: () => void) => ReactNode;
  /** Whether picking this model leaves the panel open, so its other settings can be changed next. */
  staysOpen?: (key: string) => boolean;
  /** Offered at the end of the list, to connect a provider's models. */
  onConnect?: () => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const imagesHintId = useId();
  const [open, setOpen] = useState(false);
  const { query, setQuery, showSearch, visible } = useListSearch(choices, {
    text: modelChoiceSearchText,
  });
  const sections = useMemo(() => groupModelChoices(visible, ""), [visible]);
  const selected = choices.find((choice) => choice.key === value) ?? choices[0];
  const textOnly = selected?.images === false;
  const model = selectedLabel ?? selected?.label ?? "";

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }
  const sidePanel = compact && open ? aside?.(() => openChange(false)) : null;

  return (
    <Popover open={open} onOpenChange={openChange}>
      <span id={imagesHintId} hidden>{t`Can't read images`}</span>
      {compact ? (
        <PopoverTrigger
          id={id}
          disabled={disabled}
          aria-label={detail ? t`Model: ${model}, ${detail}` : t`Model: ${model}`}
          aria-describedby={textOnly ? imagesHintId : undefined}
          className="flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-full px-2.5 text-body-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <ModelMarkIcon mark={mark} className="size-3.5 shrink-0 text-foreground" />
          <span className="min-w-0 truncate text-foreground">{model}</span>
          {detail ? <span className="shrink-0">{detail}</span> : null}
          {textOnly ? <TextOnlyMark /> : null}
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          id={id}
          disabled={disabled}
          aria-describedby={textOnly ? imagesHintId : undefined}
          className="flex min-h-12 w-full items-center justify-between gap-3 text-start text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trans>Model</Trans>
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="min-w-0 truncate">{selected?.label}</span>
            {textOnly ? <TextOnlyMark /> : null}
            <ChevronRightIcon className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
          </span>
        </PopoverTrigger>
      )}
      {open ? (
        <PopoverContent
          align={compact ? "end" : "start"}
          side={compact ? "top" : "bottom"}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className={`${
            !compact
              ? "w-(--anchor-width)"
              : sidePanel
                ? "w-[min(40rem,calc(100vw-2rem))] flex-col sm:flex-row"
                : "w-80"
          } max-h-(--available-height) gap-0 overflow-hidden bg-popover p-0 opacity-100 animate-none! backdrop-filter-none`}
        >
          <Command
            shouldFilter={false}
            className={`h-auto min-h-0 max-h-(--available-height) rounded-none bg-popover *:data-[slot=command-input-wrapper]:shrink-0 ${sidePanel ? "sm:flex-1" : ""}`}
          >
            {showSearch ? (
              <ListSearchInput
                command
                query={query}
                setQuery={setQuery}
                label={t`Search models`}
                placeholder={t`Search`}
              />
            ) : null}
            <CommandList
              className={`min-h-0 flex-1 overflow-y-auto ${compact ? "max-h-[min(28rem,60vh)]" : "max-h-80"}`}
            >
              <CommandEmpty>
                <Trans>No matching models</Trans>
              </CommandEmpty>
              {sections.map((section) => (
                <CommandGroup
                  key={section.key}
                  heading={
                    section.heading ? (
                      <span className="flex items-center gap-1.5">
                        {sectionMark(section.data) ? (
                          <ModelMarkIcon mark={sectionMark(section.data)} className="size-3" />
                        ) : null}
                        {section.heading}
                      </span>
                    ) : undefined
                  }
                >
                  {section.data.map((choice) => (
                    <CommandItem
                      key={choice.key}
                      aria-label={choice.label}
                      // cmdk falls back to the row's text for an empty value.
                      value={choice.key || "space-default"}
                      data-checked={choice.key === value}
                      aria-describedby={choice.images === false ? imagesHintId : undefined}
                      onSelect={() => {
                        onChange(choice.key);
                        if (!staysOpen?.(choice.key)) openChange(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {choice.title ?? choice.label}
                      </span>
                      {choice.images === false ? (
                        <span className="shrink-0 text-muted-foreground">
                          <TextOnlyMark />
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {onConnect ? (
                <CommandGroup>
                  <CommandItem
                    value="connect-a-model"
                    onSelect={() => {
                      openChange(false);
                      onConnect();
                    }}
                  >
                    <PlusIcon aria-hidden="true" className="size-4" />
                    {t`Connect a model`}
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
          {sidePanel ? (
            <div className="shrink-0 border-t border-border sm:w-52 sm:border-s sm:border-t-0">
              {sidePanel}
            </div>
          ) : null}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** A provider section's maker, when its models share one. */
function sectionMark(models: readonly ChatModelChoice[]) {
  const first = models[0] ? modelMark(models[0]) : undefined;
  return first && models.every((model) => modelMark(model) === first) ? first : undefined;
}
