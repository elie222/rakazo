import { useLingui } from "@lingui/react/macro";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rakazo/ui-web";
import { ChevronDown, Globe, Lock, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { IconTooltip } from "../../../components/IconTooltip";

export function SidebarSpace({
  spaceId,
  name,
  hasGuests,
  shared,
  empty,
  collapsed,
  onToggle,
  onOpen,
  onSettings,
  children,
}: {
  spaceId: string;
  name: string;
  hasGuests: boolean;
  shared: boolean;
  empty: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onSettings: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const label = empty ? t`Open ${name}` : collapsed ? t`Expand ${name}` : t`Collapse ${name}`;
  const settingsLabel = t`Settings for ${name}`;
  const SpaceIcon = hasGuests ? Globe : shared ? Users : Lock;
  const heading = (
    <>
      <SpaceIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      <span className={`min-w-0 flex-1 truncate ${empty ? "" : "pe-6"}`}>{name}</span>
      {empty ? null : (
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground motion-safe:transition-transform ${collapsed ? "-rotate-90 rtl:rotate-90" : ""}`}
        />
      )}
    </>
  );
  const triggerProps = {
    className: `col-start-1 row-start-1 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-body-sm font-semibold text-foreground hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${empty ? "pe-8" : ""}`,
    "aria-label": hasGuests ? `${label}, ${t`Shared with guests`}` : label,
  };
  return (
    <Collapsible
      open={empty || !collapsed}
      onOpenChange={onToggle}
      data-sidebar-space={spaceId}
      className="flex flex-col gap-0.5"
    >
      <div className="group/space mt-2 grid rounded-lg">
        {empty ? (
          <button type="button" onClick={onOpen} {...triggerProps}>
            {heading}
          </button>
        ) : (
          <CollapsibleTrigger {...triggerProps}>{heading}</CollapsibleTrigger>
        )}
        <IconTooltip label={settingsLabel}>
          <Button
            variant="ghost"
            size="icon-xs"
            className={`col-start-1 row-start-1 self-center justify-self-end text-muted-foreground group-hover/space:pointer-events-auto group-hover/space:opacity-100 group-has-focus-visible/space:pointer-events-auto group-has-focus-visible/space:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 ${empty ? "me-1" : "me-7"}`}
            aria-label={settingsLabel}
            onClick={onSettings}
          >
            <Settings className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </IconTooltip>
      </div>
      <CollapsibleContent className="flex flex-col gap-0.5 ps-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
