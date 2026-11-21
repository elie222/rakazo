import { cn } from "@rakazo/ui-web/lib/utils";
import { Skeleton } from "./skeleton.js";

/** Placeholder rows for a list that is still loading; the page announces the wait. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div
      data-slot="list-skeleton"
      aria-hidden="true"
      className={cn("flex flex-col gap-1", className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-14 items-center gap-2 rounded-lg px-2 py-2">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
