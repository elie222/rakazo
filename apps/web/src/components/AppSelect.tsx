import { useLingui } from "@lingui/react/macro";
import type { OptionSelectProps } from "@rakazo/ui-web";
import { OptionSelect } from "@rakazo/ui-web";

/** {@link OptionSelect} with this app's search copy, for short menus and long filterable ones. */
export function AppSelect<T extends string>(props: OptionSelectProps<T>) {
  const { t } = useLingui();
  return (
    <OptionSelect
      {...props}
      searchLabel={props.searchLabel ?? t`Search`}
      emptyLabel={props.emptyLabel ?? t`No matches`}
    />
  );
}
