import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronDown } from "lucide-react";
import type * as React from "react";

/**
 * A section that folds open: its summary with a chevron that turns when it opens. Use it for
 * every fold-out in settings so they all look and behave the same.
 */
function Disclosure({
  summary,
  summaryClassName,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"details">, "children"> & {
  summary: React.ReactNode;
  summaryClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <details data-slot="disclosure" className={cn("group/disclosure", className)} {...props}>
      <summary
        className={cn(
          "flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        {summary}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {children}
    </details>
  );
}

export { Disclosure };
