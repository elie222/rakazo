import { cn } from "@rakazo/ui-web/lib/utils";
import type { ReactNode } from "react";

/** A failure the reader can act on. The caller supplies the retry control. */
export function InlineError({
  message,
  action,
  className,
}: {
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-wrap items-center gap-3 text-body text-destructive", className)}
    >
      <span>{message}</span>
      {action}
    </div>
  );
}
