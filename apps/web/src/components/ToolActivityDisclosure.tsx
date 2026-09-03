import type { ThreadMessage } from "@rakazo/contracts";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function ToolSteps({
  steps,
  currentIndex,
}: {
  steps: Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"];
  currentIndex?: number;
}) {
  return (
    <div className="space-y-1.5" data-testid="tool-rows">
      {steps.map((step, index) => {
        const isCurrent = index === currentIndex;
        return (
          <div key={index} className="flex min-w-0 items-center gap-2">
            <span
              className={`text-[13px] ${isCurrent ? "text-warning" : "text-success"}`}
              style={{ animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
            >
              {isCurrent ? "◷" : "✓"}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[14px] ${
                isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {step.label}
              {step.count > 1 ? ` ×${step.count}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ToolActivityDisclosure({
  live,
  label,
  children,
}: {
  live: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <details
      key={live ? "working" : "actions"}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <summary
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        {label}
      </summary>
      <div className="mt-1.5 ps-1">{children}</div>
    </details>
  );
}
