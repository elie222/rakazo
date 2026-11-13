import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { useId } from "react";
import { Checkbox } from "./components/ui/checkbox.js";
import { Field, FieldLabel } from "./components/ui/field.js";
import { Input } from "./components/ui/input.js";

/** One model's limits and, where the catalog cannot tell, what it reads and whether it thinks. */
export function ModelSettingsFields({
  disabled,
  contextWindow,
  onContextWindowChange,
  contextWindowLabel,
  contextWindowPlaceholder,
  maxTokens,
  onMaxTokensChange,
  maxTokensLabel,
  maxTokensPlaceholder,
  capabilities,
  images = false,
  onImagesChange,
  imagesLabel,
  maxImagesPerPrompt,
  onMaxImagesPerPromptChange,
  maxImagesLabel,
  reasoning = false,
  onReasoningChange,
  reasoningLabel,
}: {
  disabled?: boolean;
  contextWindow: string;
  onContextWindowChange: (contextWindow: string) => void;
  contextWindowLabel: string;
  contextWindowPlaceholder?: string;
  maxTokens: string;
  onMaxTokensChange: (maxTokens: string) => void;
  maxTokensLabel: string;
  maxTokensPlaceholder?: string;
  /** Show the image and thinking settings. */
  capabilities?: boolean;
  images?: boolean;
  onImagesChange?: (images: boolean) => void;
  imagesLabel?: string;
  maxImagesPerPrompt?: string;
  onMaxImagesPerPromptChange?: (maxImagesPerPrompt: string) => void;
  maxImagesLabel?: string;
  reasoning?: boolean;
  onReasoningChange?: (reasoning: boolean) => void;
  reasoningLabel?: string;
}) {
  const contextWindowId = useId();
  const maxTokensId = useId();
  const imagesId = useId();
  const maxImagesId = useId();
  const reasoningId = useId();
  return (
    <div className="text-body text-muted-foreground">
      <Field orientation="horizontal">
        <FieldLabel htmlFor={contextWindowId}>{contextWindowLabel}</FieldLabel>
        <Input
          id={contextWindowId}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_MODEL_CONTEXT_WINDOW}
          step={1}
          value={contextWindow}
          placeholder={contextWindowPlaceholder}
          onChange={(event) => onContextWindowChange(event.target.value)}
          disabled={disabled}
          className="w-28 text-center text-foreground"
        />
      </Field>
      <Field orientation="horizontal" className="mt-3">
        <FieldLabel htmlFor={maxTokensId}>{maxTokensLabel}</FieldLabel>
        <Input
          id={maxTokensId}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_MODEL_MAX_TOKENS}
          step={1}
          value={maxTokens}
          placeholder={maxTokensPlaceholder}
          onChange={(event) => onMaxTokensChange(event.target.value)}
          disabled={disabled}
          className="w-28 text-center text-foreground"
        />
      </Field>
      {capabilities && onImagesChange ? (
        <label htmlFor={imagesId} className="mt-4 flex items-center gap-2">
          <Checkbox
            id={imagesId}
            checked={images}
            onCheckedChange={(checked) => onImagesChange(checked === true)}
            disabled={disabled}
          />
          {imagesLabel}
        </label>
      ) : null}
      {capabilities && images && onMaxImagesPerPromptChange ? (
        <Field orientation="horizontal" className="mt-3">
          <FieldLabel htmlFor={maxImagesId}>{maxImagesLabel}</FieldLabel>
          <Input
            id={maxImagesId}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            value={maxImagesPerPrompt ?? ""}
            onChange={(event) => onMaxImagesPerPromptChange(event.target.value)}
            disabled={disabled}
            className="w-28 text-center text-foreground"
          />
        </Field>
      ) : null}
      {capabilities && onReasoningChange ? (
        <label htmlFor={reasoningId} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={reasoningId}
            checked={reasoning}
            onCheckedChange={(checked) => onReasoningChange(checked === true)}
            disabled={disabled}
          />
          {reasoningLabel}
        </label>
      ) : null}
    </div>
  );
}
