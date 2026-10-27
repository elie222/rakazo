import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  buttonVariants,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronRight, Gauge } from "lucide-react";
import { useState } from "react";
import { ProviderQuotaStack } from "./provider-quota-stack";

export function UsagePopover({ onUsage }: { onUsage: () => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="usage-menu-trigger"
        className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
      >
        <Gauge className="text-muted-foreground" strokeWidth={1.75} />
        <Trans>Usage</Trans>
        <ChevronRight className="ms-auto text-muted-foreground" strokeWidth={1.75} />
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          side="right"
          align="end"
          sideOffset={8}
          aria-label={t`Usage`}
          data-testid="usage-popover"
          className="max-h-(--available-height) w-80 max-w-[calc(100vw-24px)] gap-0 overflow-y-auto p-0"
        >
          <div className="border-b border-border px-4 py-3">
            <PopoverTitle>
              <Trans>Usage</Trans>
            </PopoverTitle>
          </div>
          <div className="p-4">
            <ProviderQuotaStack compact />
          </div>
          <div className="border-t border-border p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              onClick={() => {
                setOpen(false);
                onUsage();
              }}
            >
              <Trans>View usage</Trans>
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
