import type { SettingsScope } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageLoading } from "../../components/PageLoading";
import { errorText } from "../../lib/query/user-error";
import { ModelAccountSettings } from "./ModelAccountSettings";
import { modelAccountConfigQuery } from "./queries";

export function ModelSettingsEntry({
  fallback,
  ...props
}: {
  fallback: ReactNode;
  onClose: () => void;
  embedded?: boolean;
  scope: SettingsScope;
}) {
  const config = useQuery(modelAccountConfigQuery);
  if (!config.data)
    return config.error ? <p role="alert">{errorText(config.error)}</p> : <PageLoading />;
  return config.data.modelAccountOnly ? <ModelAccountSettings {...props} /> : fallback;
}
