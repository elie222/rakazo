import { Trans, useLingui } from "@lingui/react/macro";
import { useListSearch } from "@rakazo/chat-ui/hooks";
import type { VoiceInfo } from "@rakazo/contracts";
import {
  Button,
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
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

/** The language codes the voices speak, most common first. */
export function voiceLanguageCodes(voices: readonly VoiceInfo[]): string[] {
  const counts = new Map<string, number>();
  for (const voice of voices) {
    for (const code of voice.languages ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
}

function voiceText(voice: VoiceInfo): string {
  return voice.description ? `${voice.label} (${voice.description})` : voice.label;
}

/**
 * A searchable voice list for providers with many voices: type part of a name to narrow it, or
 * pick a language code (such as `de` or `en`) to keep only the voices that speak it.
 */
export function VoicePicker({
  id,
  voices,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  voices: readonly VoiceInfo[];
  value: string;
  disabled?: boolean;
  onChange: (voiceId: string) => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<string | null>(null);
  const codes = useMemo(() => voiceLanguageCodes(voices), [voices]);
  const activeLanguage = language && codes.includes(language) ? language : null;
  const inLanguage = useMemo(
    () =>
      activeLanguage ? voices.filter((voice) => voice.languages?.includes(activeLanguage)) : voices,
    [voices, activeLanguage],
  );
  const { query, setQuery, visible } = useListSearch(inLanguage, {
    text: (voice) => [voice.label, voice.description],
    threshold: 0,
  });
  const selected = voices.find((voice) => voice.id === value);
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        id={id}
        disabled={disabled}
        render={<Button variant="outline" className="w-full justify-between font-normal" />}
      >
        <span className="min-w-0 truncate">{selected ? voiceText(selected) : value}</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        initialFocus={searchRef}
        className="w-80 max-w-(--available-width) gap-0 overflow-hidden p-0"
      >
        <Command label={t`Search voices`} shouldFilter={false} className="rounded-none">
          <ListSearchInput
            command
            inputRef={searchRef}
            query={query}
            setQuery={setQuery}
            label={t`Search voices`}
            placeholder={t`Search`}
          />
          {codes.length > 1 ? (
            <fieldset
              className="m-0 flex max-h-20 min-w-0 flex-wrap gap-1 overflow-y-auto border-0 p-1"
              aria-label={t`Language`}
            >
              <Button
                type="button"
                size="xs"
                variant={activeLanguage === null ? "default" : "secondary"}
                aria-pressed={activeLanguage === null}
                className="rounded-full"
                onClick={() => setLanguage(null)}
              >
                <Trans>All</Trans>
              </Button>
              {codes.map((code) => (
                <Button
                  key={code}
                  type="button"
                  size="xs"
                  variant={activeLanguage === code ? "default" : "secondary"}
                  aria-pressed={activeLanguage === code}
                  className="rounded-full"
                  onClick={() => setLanguage(activeLanguage === code ? null : code)}
                >
                  {code}
                </Button>
              ))}
            </fieldset>
          ) : null}
          <CommandList label={t`Voices`}>
            <CommandEmpty>
              <Trans>No matching voices</Trans>
            </CommandEmpty>
            <CommandGroup>
              {visible.map((voice) => (
                <CommandItem
                  key={voice.id}
                  value={voice.id}
                  aria-label={voiceText(voice)}
                  data-checked={voice.id === value}
                  onSelect={() => {
                    onChange(voice.id);
                    close();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{voiceText(voice)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
