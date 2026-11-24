import { Trans } from "@lingui/react/macro";
import type { RoutineUpdateApproval } from "@rakazo/contracts";
import {
  routineApprovalLabel,
  routineApprovalPrevious,
  routineApprovalValue,
} from "@rakazo/i18n/routine-approval";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";

export function RoutineApprovalDetail({ review }: { review: RoutineUpdateApproval }) {
  return (
    <div className="mt-4 min-w-0">
      {review.reason ? (
        <p className="mb-3 whitespace-pre-wrap break-words text-body-sm text-muted-foreground">
          {review.reason}
        </p>
      ) : null}
      <dl className="divide-y divide-border">
        {review.changes.map(({ field, before, after }) => {
          const previous = routineApprovalValue(field, before);
          return (
            <div key={field} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <dt className="text-body-sm font-medium text-muted-foreground">
                {routineApprovalLabel(field)}
              </dt>
              <dd className="whitespace-pre-wrap break-words text-body font-medium">
                {routineApprovalValue(field, after)}
              </dd>
              {field === "prompt" ? (
                <dd>
                  <Collapsible>
                    <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm py-1 text-start text-body-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <ChevronRight
                        aria-hidden
                        className="size-3.5 group-data-panel-open:rotate-90 rtl:rotate-180"
                      />
                      <Trans>Previous instructions</Trans>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="mt-1 border-s-2 border-border ps-3 whitespace-pre-wrap break-words text-body-sm text-muted-foreground">
                        {previous}
                      </p>
                    </CollapsibleContent>
                  </Collapsible>
                </dd>
              ) : (
                <dd className="whitespace-pre-wrap break-words text-body-sm text-muted-foreground">
                  {routineApprovalPrevious(previous)}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
