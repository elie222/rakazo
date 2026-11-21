import { cn } from "@rakazo/ui-web/lib/utils";
import type { ReactNode } from "react";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty.js";

/**
 * A list or page with nothing to show. Keep the title to the one fact the reader needs;
 * the action, when there is one, is the way out.
 */
export function EmptyState({
  icon,
  title,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("min-h-40", className)}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
