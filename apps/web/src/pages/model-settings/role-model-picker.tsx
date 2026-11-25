import { Trans, useLingui } from "@lingui/react/macro";
import { useListSearch } from "@rakazo/chat-ui/hooks";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { modelCatalogSearchText, newestModelsFirst } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../../lib/models/model-auth";

/** `baseUrl` presets an OpenAI-compatible server, such as a hosted preset. */
export type ConnectableProvider = { id: string; name: string; baseUrl?: string };

/** A model on one connection; `providerName` is that connection's name. */
export type RoleModelOption = ModelCatalogEntry & {
  credentialId?: string;
  creditOfferingId?: string;
};

/** The row that opens a role's picker: the model's name, and what runs it beside. */
export function rolePickerTrigger(label: string, sub?: string) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md py-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="truncate text-body-lg text-foreground">{label}</span>
      {sub ? <span className="truncate text-body-sm text-muted-foreground">{sub}</span> : null}
    </button>
  );
}

const optionValue = (option: RoleModelOption) =>
  `${option.provider}:${option.id}:${option.creditOfferingId ? `credits:${option.creditOfferingId}` : (option.credentialId ?? "")}`;

/**
 * One picker for every model a role can use: connected models pick directly, and
 * providers that still need a connection hand off to the connect dialog.
 */
export function RoleModelPicker({
  trigger,
  label,
  options,
  providers,
  defaultOption,
  current,
  disabled,
  onPick,
  onConnect,
  reopen,
  onReopened,
}: {
  trigger: ReactElement;
  label: string;
  options: RoleModelOption[];
  providers: ConnectableProvider[];
  /** The deployment's model, offered to clear the slot back to it; `included` when it pays. */
  defaultOption?: { label: string; included?: boolean };
  /** The model in use; its row is checked and active when the picker opens, and picking it only closes. */
  current?: { provider: string; modelId: string; credentialId?: string; creditOfferingId?: string };
  disabled?: boolean;
  onPick: (option: RoleModelOption | null) => void;
  onConnect: (provider: ConnectableProvider) => void;
  /** Opens the picker searching for `query`, e.g. a provider that just connected. */
  reopen?: { query: string; key: number };
  /**
   * Called when a picker opened by `reopen` closes. Until then the request stands, so a row
   * that is replaced while its picker is open (a reload settling) reopens in its new row.
   */
  onReopened?: () => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const rows = [
    ...options.map((option) => ({ option, provider: undefined })),
    ...providers.map((provider) => ({ option: undefined, provider })),
  ];
  // Set when the search changes, until cmdk's own answer to it (or the next key) is handled.
  const searched = useRef(false);
  const {
    query,
    setQuery: setSearch,
    showSearch,
    visible,
  } = useListSearch(rows, {
    text: (row) => (row.option ? modelCatalogSearchText(row.option) : row.provider!.name),
  });
  const setQuery = (next: string) => {
    searched.current = true;
    setSearch(next);
  };
  const groups = useMemo(() => {
    const grouped = new Map<string, RoleModelOption[]>();
    for (const row of visible) {
      if (!row.option) continue;
      const option = row.option;
      const name = option.providerName ?? option.provider;
      grouped.set(name, [...(grouped.get(name) ?? []), option]);
    }
    return [...grouped].map(([name, entries]) => [name, newestModelsFirst(entries)] as const);
  }, [visible]);
  const needle = query.trim();
  const matchingProviders = visible.flatMap((row) => (row.provider ? [row.provider] : []));
  const values = [
    ...(defaultOption && !needle ? ["default"] : []),
    ...groups.flatMap(([, entries]) => entries.map(optionValue)),
    ...matchingProviders.map((provider) => `connect:${provider.id}:${provider.baseUrl ?? ""}`),
  ];
  // The model in use is the row with the same connection or credit offering; no connection
  // matches only a row with none, so an included model never marks someone's own connection.
  // Provider ids compare canonically, so a choice saved under a provider's older id still matches.
  const currentOption =
    current &&
    options.find(
      (option) =>
        canonicalPiProviderId(option.provider) === canonicalPiProviderId(current.provider) &&
        option.id === current.modelId &&
        option.credentialId === current.credentialId &&
        option.creditOfferingId === current.creditOfferingId,
    );
  const currentValue = currentOption ? optionValue(currentOption) : undefined;
  // The model in use is active when opened, else the first row, so Enter always picks something;
  // searching moves it to the first match.
  const [activeValue, setActiveValue] = useState("");
  const startValue = (!needle && currentValue) || values[0] || "";
  useEffect(() => {
    if (open) setActiveValue(startValue);
  }, [startValue, open]);
  const fromReopen = useRef(false);
  const close = () => {
    setOpen(false);
    if (!fromReopen.current) return;
    fromReopen.current = false;
    reopened.current?.();
  };
  // Keyed on the request, so later renders of the same request do not reopen it.
  const reopenKey = reopen?.key;
  const reopenQuery = useRef(reopen?.query);
  reopenQuery.current = reopen?.query;
  const reopened = useRef(onReopened);
  reopened.current = onReopened;
  useEffect(() => {
    if (reopenKey === undefined) return;
    setQuery(reopenQuery.current ?? "");
    setOpen(true);
    fromReopen.current = true;
  }, [reopenKey]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) return close();
        setQuery("");
        setOpen(true);
      }}
    >
      <PopoverTrigger render={trigger} aria-label={label} disabled={disabled} />
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={showSearch ? searchRef : undefined}
        className="w-[min(360px,var(--available-width))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <Command
          tabIndex={showSearch ? undefined : 0}
          ref={(command) => {
            if (!command || !searchRef.current) return;
            // cmdk can keep a stale selected item when the controlled value changes before
            // filtered rows commit, so the input names the committed active row itself.
            const active = [...command.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
              (item) => item.dataset.value === activeValue,
            );
            if (active) searchRef.current.setAttribute("aria-activedescendant", active.id);
            else searchRef.current.removeAttribute("aria-activedescendant");
          }}
          label={t`Search models`}
          shouldFilter={false}
          loop
          value={activeValue}
          onKeyDown={() => {
            searched.current = false;
          }}
          onValueChange={(value) => {
            // cmdk moves the active row to its first row after a search changes, which would
            // lose the model in use when the box is cleared; the first answer is ours to replace.
            const settled = searched.current;
            searched.current = false;
            setActiveValue(settled ? startValue : value);
          }}
        >
          {showSearch ? (
            <ListSearchInput
              command
              inputRef={searchRef}
              query={query}
              setQuery={setQuery}
              label={t`Search models`}
              placeholder={t`Search`}
            />
          ) : null}
          <CommandList label={t`Model options`} className="rk-scroll max-h-80">
            <CommandEmpty>
              <Trans>No matching models</Trans>
            </CommandEmpty>
            {defaultOption && !needle ? (
              <CommandGroup>
                <CommandItem
                  value="default"
                  onSelect={() => {
                    onPick(null);
                    close();
                  }}
                >
                  <span className="min-w-0 truncate">{defaultOption.label}</span>
                  <CommandShortcut className="text-body-sm tracking-normal">
                    {defaultOption.included ? <Trans>Included</Trans> : <Trans>Default</Trans>}
                  </CommandShortcut>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map(([name, entries]) => (
              <CommandGroup key={name} heading={name}>
                {entries.map((option) => (
                  <CommandItem
                    key={optionValue(option)}
                    value={optionValue(option)}
                    data-checked={optionValue(option) === currentValue}
                    onSelect={() => {
                      // The model in use is already saved; picking it again changes nothing.
                      if (optionValue(option) !== currentValue) onPick(option);
                      close();
                    }}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {matchingProviders.length && groups.length ? <CommandSeparator /> : null}
            {matchingProviders.length ? (
              <CommandGroup>
                {matchingProviders.map((provider) => (
                  <CommandItem
                    key={`${provider.id}:${provider.baseUrl ?? ""}`}
                    value={`connect:${provider.id}:${provider.baseUrl ?? ""}`}
                    onSelect={() => {
                      close();
                      onConnect(provider);
                    }}
                  >
                    <span className="min-w-0 truncate">{provider.name}</span>
                    <CommandShortcut className="text-body-sm tracking-normal">
                      <Trans>Connect</Trans>
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
