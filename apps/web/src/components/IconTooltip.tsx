import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import type { ReactElement } from "react";

/** Shows `label` beside an icon-only control on hover and focus; the control keeps its own accessible name. */
export function IconTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
