import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionOwnerChoice } from "@rakazo/core";
import { Field, FieldLabel, OptionSelect } from "@rakazo/ui-web";
import { useId } from "react";

export function ConnectionOwnerPicker({
  organizationName,
  value,
  onChange,
}: {
  organizationName: string;
  value: ConnectionOwnerChoice;
  onChange: (value: ConnectionOwnerChoice) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <Field>
      <FieldLabel id={labelId} htmlFor={id}>
        <Trans>Available to</Trans>
      </FieldLabel>
      <OptionSelect
        id={id}
        aria-labelledby={labelId}
        value={value}
        onValueChange={(owner) => onChange(owner === "organization" ? "organization" : "me")}
        options={[
          { value: "me", label: t`Just me` },
          { value: "organization", label: organizationName },
        ]}
      />
    </Field>
  );
}
