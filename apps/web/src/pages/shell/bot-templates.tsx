import { Trans, useLingui } from "@lingui/react/macro";
import type { BotTemplate } from "@rakazo/contracts";
import { searchBotTemplates } from "@rakazo/contracts";
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function BotTemplates({ onSelect }: { onSelect: (template: BotTemplate) => void }) {
  const { t } = useLingui();
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.bots
      .templates()
      .then((items) => {
        if (active) setTemplates(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!templates.length) return null;

  function select(template: BotTemplate) {
    onSelect(template);
    setOpen(false);
  }

  return (
    <div data-testid="bot-templates" className="mb-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          <Trans>Start from a template</Trans>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
        >
          <Trans>Browse all</Trans>
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {templates
          .filter((template) => template.featured)
          .slice(0, 8)
          .map((template) => (
            <Button
              key={template.slug}
              variant="outline"
              size="sm"
              onClick={() => select(template)}
            >
              {template.name}
            </Button>
          ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>
            <Trans>Start from a template</Trans>
          </DialogTitle>
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t`Search`}
              aria-label={t`Search`}
            />
            <CommandList>
              <CommandEmpty>
                <Trans>No bots match</Trans>
              </CommandEmpty>
              {searchBotTemplates(templates, query).map((template) => (
                <CommandItem
                  key={template.slug}
                  value={template.slug}
                  onSelect={() => select(template)}
                >
                  {template.name}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
