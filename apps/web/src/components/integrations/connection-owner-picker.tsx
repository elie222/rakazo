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
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <Trans>Available to</Trans>
      </FieldLabel>
      <OptionSelect
        id={id}
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
