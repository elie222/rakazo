import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices, modelChoiceSearchText } from "@rakazo/core";
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
import { ChevronRightIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { TextOnlyMark } from "../../components/TextOnlyMark";
import { useListSearch } from "../../lib/use-list-search";

/** A bot's model as one settings row: the row names the model in use and opens the list. */
export function ChatModelPicker({
  id,
  choices,
  value,
  onChange,
}: {
  id: string;
  choices: readonly ChatModelChoice[];
  value: string;
  onChange: (key: string) => void;
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

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <span id={imagesHintId} hidden>{t`Can't read images`}</span>
      <PopoverTrigger
        id={id}
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
      {open ? (
        <PopoverContent
          align="start"
          side="bottom"
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className="w-(--anchor-width) max-h-(--available-height) gap-0 overflow-hidden bg-popover p-0 opacity-100 animate-none! backdrop-filter-none"
        >
          <Command
            shouldFilter={false}
            className="h-auto min-h-0 max-h-(--available-height) rounded-none bg-popover *:data-[slot=command-input-wrapper]:shrink-0"
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
            <CommandList className="min-h-0 max-h-80 flex-1 overflow-y-auto">
              <CommandEmpty>
                <Trans>No matching models</Trans>
              </CommandEmpty>
              {sections.map((section) => (
                <CommandGroup key={section.key} heading={section.heading}>
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
                        openChange(false);
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
            </CommandList>
          </Command>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
