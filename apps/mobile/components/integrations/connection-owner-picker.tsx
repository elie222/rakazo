import { useLingui } from "@lingui/react/macro";
import type { ConnectionOwnerChoice } from "@rakazo/core";
import { MenuPicker } from "../ui/menu-picker";

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
  return (
    <MenuPicker
      label={t`Available to`}
      plain
      value={value}
      choices={[
        { key: "me", label: t`Just me` },
        { key: "organization", label: organizationName },
      ]}
      onChange={(key) => onChange(key === "organization" ? "organization" : "me")}
    />
  );
}
