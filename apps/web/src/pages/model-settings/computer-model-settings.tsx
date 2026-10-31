import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerModelTarget, ThinkingLevel } from "@rakazo/contracts";
import { computerModelKey, createComputerModelSettings } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { useSpaceRpc } from "../../lib/space-rpc";

export function ComputerModelSettings({
  target,
  userId,
  spaceId,
  label,
}: {
  target: ComputerModelTarget;
  userId: string;
  spaceId: string;
  label?: string;
}) {
  const { t } = useLingui();
  const id = useId();
  const rpc = useSpaceRpc();
  const targetKey = JSON.stringify(target);
  const controller = useMemo(() => {
    const capturedTarget: ComputerModelTarget = JSON.parse(targetKey);
    const input = { target: capturedTarget, expectedUserId: userId };
    return createComputerModelSettings(
      {
        load: () => rpc.models.computer(input),
        save: (selection) => rpc.models.setComputer({ ...input, selection }),
      },
      JSON.stringify([userId, spaceId, targetKey]),
    );
  }, [targetKey, userId, spaceId, rpc]);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const selection = state.view?.selection ?? null;
  const key = computerModelKey(selection);
  const selected = state.view?.options.find((entry) => computerModelKey(entry) === key);
  const blocked = state.busy || state.stale;
  return (
    <div className="space-y-2" aria-busy={state.busy}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label ?? t`Computer-use model`}
      </label>
      {state.view ? (
        <>
          <NativeSelect
            id={id}
            value={key}
            disabled={blocked}
            className="w-full"
            onChange={(event) => {
              const value = event.target.value;
              const choice = state.view?.options.find((entry) => computerModelKey(entry) === value);
              void controller.save(
                value === "inherit"
                  ? null
                  : value === "main"
                    ? { mode: "main" }
                    : choice
                      ? {
                          mode: "model",
                          provider: choice.provider,
                          modelId: choice.modelId,
                          credentialId: choice.credentialId,
                          thinkingLevel: null,
                        }
                      : selection,
              );
            }}
          >
            <NativeSelectOption value="inherit">
              {target.kind === "bot" ? t`Use provider default` : t`Same as main model`}
            </NativeSelectOption>
            {target.kind === "bot" ? (
              <NativeSelectOption value="main">{t`Same as main model`}</NativeSelectOption>
            ) : null}
            {selection?.mode === "model" && !selected ? (
              <NativeSelectOption value={key}>
                {selection.modelId} — {t`Unavailable`}
              </NativeSelectOption>
            ) : null}
            {state.view.options.map((entry) => (
              <NativeSelectOption key={computerModelKey(entry)} value={computerModelKey(entry)}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {selected && selected.thinkingLevels.length > 0 && selection?.mode === "model" ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground py-2">
                <Trans>Thinking</Trans>
              </summary>
              <NativeSelect
                aria-label={t`Computer thinking`}
                value={selection.thinkingLevel ?? ""}
                disabled={blocked}
                onChange={(event) =>
                  void controller.save({
                    ...selection,
                    thinkingLevel: (event.target.value || null) as ThinkingLevel | null,
                  })
                }
              >
                <NativeSelectOption value="">{t`Default (Medium)`}</NativeSelectOption>
                {selected.thinkingLevels.map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {thinkingLevelLabel(level)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </details>
          ) : null}
        </>
      ) : state.busy ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {state.error ? (
        <div role="alert" className="text-sm text-destructive">
          <p>{state.error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={() => void controller.load()}
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
