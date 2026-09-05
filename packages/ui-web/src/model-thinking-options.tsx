import { useId } from "react";
import { Checkbox } from "./components/ui/checkbox.js";

export function ModelThinkingOptions({
  reasoning,
  onReasoningChange,
  disabled,
  advancedLabel,
  thinkingLabel,
}: {
  reasoning: boolean;
  onReasoningChange: (reasoning: boolean) => void;
  disabled?: boolean;
  advancedLabel: string;
  thinkingLabel: string;
}) {
  const id = useId();
  return (
    <details className="mt-4 text-sm text-muted-foreground">
      <summary className="cursor-pointer">{advancedLabel}</summary>
      <label htmlFor={id} className="mt-3 flex items-center gap-2">
        <Checkbox
          id={id}
          checked={reasoning}
          onCheckedChange={(checked) => onReasoningChange(checked === true)}
          disabled={disabled}
        />
        {thinkingLabel}
      </label>
    </details>
  );
}
