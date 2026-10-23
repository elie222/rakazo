import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import { ModelThinkingOptions, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { thinkingLevelLabel } from "../../lib/model-catalog";

import { ModelPicker } from "./model-picker";
import type { ModelSettingsState } from "./use-model-settings";

export function CatalogModelFields({
  busy,
  cancelOAuthAttempt,
  catalogThinkingLevels,
  credential,
  invalidatePreflight,
  isOpenAiCompatible,
  maxTokens,
  modelsForProvider,
  selected,
  selectionRevisionRef,
  setError,
  setMaxTokens,
  setModelId,
  setNotice,
  setThinkingLevel,
  thinkingLevel,
  usingServerCredentials,
}: Pick<
  ModelSettingsState,
  | "busy"
  | "cancelOAuthAttempt"
  | "catalogThinkingLevels"
  | "credential"
  | "invalidatePreflight"
  | "isOpenAiCompatible"
  | "maxTokens"
  | "modelsForProvider"
  | "selected"
  | "selectionRevisionRef"
  | "setError"
  | "setMaxTokens"
  | "setModelId"
  | "setNotice"
  | "setThinkingLevel"
  | "thinkingLevel"
  | "usingServerCredentials"
>) {
  const { t } = useLingui();
  return !isOpenAiCompatible && selected ? (
    <>
      <div className="block text-[13.5px] text-muted-foreground">
        <span>
          <Trans>Model</Trans>
        </span>
        <ModelPicker
          options={modelsForProvider}
          value={selected.id}
          onChange={(nextModelId) => {
            cancelOAuthAttempt();
            selectionRevisionRef.current += 1;
            invalidatePreflight();
            setModelId(nextModelId);
            const nextEntry = modelsForProvider.find((entry) => entry.id === nextModelId);
            setThinkingLevel(
              clampCatalogThinkingLevel(
                nextModelId === credential?.modelId ? credential?.thinkingLevel : null,
                nextEntry?.thinkingLevels,
              ) as ThinkingLevel | null,
            );
            setError(null);
            setNotice(null);
          }}
        />
        <ModelThinkingOptions
          showThinking={false}
          disabled={busy}
          advancedLabel={t`Advanced`}
          maxTokens={maxTokens}
          onMaxTokensChange={(value) => {
            selectionRevisionRef.current += 1;
            setMaxTokens(value);
            setNotice(null);
          }}
          maxTokensLabel={t`Maximum output tokens`}
        />
      </div>
      {catalogThinkingLevels.length ? (
        <label
          className="mt-4 block text-[13.5px] text-muted-foreground"
          htmlFor="model-thinking-level"
        >
          <Trans>Thinking</Trans>
          <NativeSelect
            id="model-thinking-level"
            className="mt-2 w-full text-foreground"
            value={thinkingLevel ?? ""}
            disabled={busy}
            onChange={(event) => {
              selectionRevisionRef.current += 1;
              setThinkingLevel((event.target.value || null) as ThinkingLevel | null);
              setNotice(null);
            }}
          >
            <NativeSelectOption value="">
              {i18n._({
                id: "Default ({0})",
                message: "Default ({0})",
                values: { "0": thinkingLevelLabel("medium") },
              })}
            </NativeSelectOption>
            {catalogThinkingLevels.map((level) => (
              <NativeSelectOption key={level} value={level}>
                {thinkingLevelLabel(level)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {selected.billing && !usingServerCredentials ? (
        <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">{selected.billing}</p>
      ) : null}
    </>
  ) : null;
}
