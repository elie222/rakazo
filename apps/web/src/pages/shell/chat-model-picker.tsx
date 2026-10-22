import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices, MODEL_SEARCH_THRESHOLD } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

/** A chat's model: a native select, or a searchable list once there are too many to scan. */
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sections = useMemo(() => groupModelChoices(choices, query), [choices, query]);

  if (choices.length <= MODEL_SEARCH_THRESHOLD) {
    return (
      <NativeSelect
        id={id}
        className="mt-2 w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <NativeSelectOption key={choice.key} value={choice.key}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        id={id}
        className="mt-2 flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent pr-2.5 pl-2.5 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
      >
        <span className="min-w-0 truncate">
          {choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t`Search`}
              aria-label={t`Search models`}
            />
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
                      onSelect={() => {
                        onChange(choice.key);
                        openChange(false);
                      }}
                    >
                      <span className="min-w-0 truncate">{choice.title ?? choice.label}</span>
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
