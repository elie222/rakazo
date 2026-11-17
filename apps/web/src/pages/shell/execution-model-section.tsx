import type { ComponentProps } from "react";
import { ExecutionSettings } from "../../components/ExecutionSettings";
import { ModelRow } from "./bot-settings-sections";

export function ExecutionModelSection({
  botId,
  ...props
}: ComponentProps<typeof ModelRow> & { botId: string }) {
  return (
    <ExecutionSettings botId={botId}>
      {(model) => (
        <ModelRow
          {...props}
          {...(model
            ? {
                choices: model.choices,
                value: model.value,
                onModelChange: model.onChange,
                thinkingOptions: [],
              }
            : {})}
        />
      )}
    </ExecutionSettings>
  );
}
