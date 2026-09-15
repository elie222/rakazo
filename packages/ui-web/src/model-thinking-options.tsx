import { useId } from "react";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.js";

export function ModelThinkingOptions({
  reasoning,
  onReasoningChange,
  supportsImages,
  onSupportsImagesChange,
  maxImagesPerPrompt,
  onMaxImagesPerPromptChange,
  disabled,
  advancedLabel,
  thinkingLabel,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingLevelOptions,
  thinkingLevelLabel,
  thinkingLevelDefaultLabel,
  maxTokens,
  onMaxTokensChange,
  maxTokensLabel,
  contextWindow,
  onContextWindowChange,
  contextWindowLabel,
  imagesLabel,
  maxImagesLabel,
}: {
  reasoning: boolean;
  onReasoningChange: (reasoning: boolean) => void;
  supportsImages?: boolean;
  onSupportsImagesChange?: (supportsImages: boolean) => void;
  maxImagesPerPrompt?: string;
  onMaxImagesPerPromptChange?: (maxImagesPerPrompt: string) => void;
  disabled?: boolean;
  advancedLabel: string;
  thinkingLabel: string;
  thinkingLevel?: string | null;
  onThinkingLevelChange?: (thinkingLevel: string | null) => void;
  thinkingLevelOptions?: ReadonlyArray<{ value: string; label: string }>;
  thinkingLevelLabel?: string;
  thinkingLevelDefaultLabel?: string;
  maxTokens?: string;
  onMaxTokensChange?: (maxTokens: string) => void;
  maxTokensLabel?: string;
  contextWindow?: string;
  onContextWindowChange?: (contextWindow: string) => void;
  contextWindowLabel?: string;
  imagesLabel?: string;
  maxImagesLabel?: string;
}) {
  const id = useId();
  const thinkingLevelId = useId();
  const maxTokensId = useId();
  const contextWindowId = useId();
  const imagesId = useId();
  const maxImagesId = useId();
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
      {reasoning &&
      onThinkingLevelChange &&
      thinkingLevelOptions &&
      thinkingLevelOptions.length > 0 ? (
        <label htmlFor={thinkingLevelId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{thinkingLevelLabel}</span>
          <NativeSelect
            id={thinkingLevelId}
            value={thinkingLevel ?? ""}
            onChange={(event) => onThinkingLevelChange(event.target.value || null)}
            disabled={disabled}
            aria-label={thinkingLevelLabel}
            className="h-8 w-32 text-foreground"
          >
            <NativeSelectOption value="">{thinkingLevelDefaultLabel}</NativeSelectOption>
            {thinkingLevelOptions.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {onMaxTokensChange && maxTokensLabel ? (
        <label htmlFor={maxTokensId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{maxTokensLabel}</span>
          <Input
            id={maxTokensId}
            type="number"
            inputMode="numeric"
            min={1}
            max={131072}
            step={1}
            value={maxTokens ?? ""}
            onChange={(event) => onMaxTokensChange(event.target.value)}
            disabled={disabled}
            aria-label={maxTokensLabel}
            className="h-8 w-24 text-center text-foreground"
          />
        </label>
      ) : null}
      {onContextWindowChange && contextWindowLabel ? (
        <label htmlFor={contextWindowId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{contextWindowLabel}</span>
          <Input
            id={contextWindowId}
            type="number"
            inputMode="numeric"
            min={1}
            max={1048576}
            step={1}
            value={contextWindow ?? ""}
            onChange={(event) => onContextWindowChange(event.target.value)}
            disabled={disabled}
            aria-label={contextWindowLabel}
            className="h-8 w-24 text-center text-foreground"
          />
        </label>
      ) : null}
      {onSupportsImagesChange ? (
        <label htmlFor={imagesId} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={imagesId}
            checked={supportsImages === true}
            onCheckedChange={(checked) => onSupportsImagesChange(checked === true)}
            disabled={disabled}
          />
          {imagesLabel}
        </label>
      ) : null}
      {supportsImages && onMaxImagesPerPromptChange ? (
        <label htmlFor={maxImagesId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{maxImagesLabel}</span>
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
            aria-label={maxImagesLabel}
            className="h-8 w-20 text-center text-foreground"
          />
        </label>
      ) : null}
    </details>
  );
}
