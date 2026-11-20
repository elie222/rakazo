import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ModelAccountOnboarding } from "../../components/ModelAccountOnboarding";
import { PageLoading } from "../../components/PageLoading";
import { errorText } from "../../lib/query/user-error";
import { modelAccountConfigQuery } from "./queries";

/** Account policy is needed only at model setup; other onboarding steps use the upstream flow. */
export function useModelAccountOnboarding(step: string, onReady: () => void) {
  const config = useQuery({ ...modelAccountConfigQuery, enabled: step === "model" });
  const accountMode = !config.data || Boolean(config.data.modelAccountOnly);
  const content = config.data ? (
    <ModelAccountOnboarding enabled onReady={onReady} />
  ) : config.error ? (
    <div>
      <p role="alert" className="text-body text-destructive">
        {errorText(config.error)}
      </p>
      <Button disabled={config.isFetching} onClick={() => void config.refetch()}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  ) : (
    <PageLoading />
  );
  return { accountMode, content };
}
