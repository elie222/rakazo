import { listSearch, MODEL_SEARCH_THRESHOLD } from "@rakazo/core";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Command, CommandEmpty, CommandItem, CommandList } from "./command.js";
import { ListSearchInput } from "./list-search-input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectTriggerClassName,
} from "./select.js";

/** One choice in an {@link OptionSelect}. */
type SelectOption<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
};

type OptionSelectProps<T extends string> = {
  id?: string;
  /** null shows nothing chosen yet. An empty string is a real choice when an option uses it. */
  value: T | null;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
  /** Shown above a long list. Defaults to English; app wrappers pass a translation. */
  searchLabel?: string;
  /** Shown when a search matches nothing. */
  emptyLabel?: string;
};

/**
 * A dropdown over a fixed list of options: the app's menu, never the browser's own, so every
 * dropdown looks and behaves the same. Lists longer than {@link MODEL_SEARCH_THRESHOLD} get a
 * search field. Give it an `id` to pair it with a `FieldLabel`.
 */
function OptionSelect<T extends string>({
  options,
  searchLabel = "Search",
  emptyLabel = "No matches",
  ...props
}: OptionSelectProps<T>) {
  if (options.length > MODEL_SEARCH_THRESHOLD) {
    return (
      <SearchableOptionSelect
        {...props}
        options={options}
        searchLabel={searchLabel}
        emptyLabel={emptyLabel}
      />
    );
  }
  return <MenuOptionSelect {...props} options={options} />;
}

function MenuOptionSelect<T extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "data-testid": testId,
}: OptionSelectProps<T>) {
  return (
    <Select
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((entry) => entry.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-testid={testId}
        className={cn("w-full", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value || "\u0000"}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SearchableOptionSelect<T extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "data-testid": testId,
  searchLabel = "Search",
  emptyLabel = "No matches",
}: OptionSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { visible } = listSearch(options, query, { text: (option) => option.label });
  const selected = options.find((option) => option.value === value);
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <PopoverTrigger
        id={id}
        type="button"
        disabled={disabled}
        data-size={size}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-testid={testId}
        className={cn(selectTriggerClassName, "w-full", className)}
      >
        <span className="line-clamp-1 flex flex-1 text-left">{selected?.label}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--anchor-width) gap-0 overflow-hidden p-0"
      >
        <Command
          shouldFilter={false}
          loop
          className="h-auto max-h-80 rounded-none! bg-transparent p-0"
        >
          {/* Inset the field so its border and focus ring survive the menu's overflow clip. */}
          <div className="p-1.5 pb-0">
            <ListSearchInput
              command
              query={query}
              setQuery={setQuery}
              label={searchLabel}
              placeholder={searchLabel}
            />
          </div>
          <CommandList className="max-h-72 p-1">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {visible.map((option, index) => (
              <CommandItem
                key={option.value || `\u0000${index}`}
                value={option.value || `\u0000${index}`}
                disabled={option.disabled}
                data-checked={option.value === value}
                onSelect={() => {
                  if (option.disabled) return;
                  onValueChange(option.value);
                  close();
                }}
              >
                <span className="min-w-0 truncate">{option.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export type { OptionSelectProps, SelectOption };
export { OptionSelect };
