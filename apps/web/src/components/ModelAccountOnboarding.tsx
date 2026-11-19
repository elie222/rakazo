import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { rpc } from "../lib/query/rpc";
import { AccountI18n } from "../pages/model-account/AccountI18n";

const AccountModelSettings = lazy(() =>
  import("../pages/model-account/ModelAccountSettings").then((module) => ({
    default: module.ModelAccountSettings,
  })),
);

function ModelAccountOnboardingContent({
  enabled,
  onReady,
}: {
  enabled?: boolean;
  onReady: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectingModel, setSelectingModel] = useState(false);
  const checkReady = async () => {
    try {
      const me = await rpc.me();
      if (!me.needsModel) onReady();
      else setSelectingModel(true);
    } catch {
      // The model page remains available for retry.
    }
  };
  const open = searchParams.get("settings") !== "closed";
  const setOpen = (value: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("settings", "models");
    else next.set("settings", "closed");
    setSearchParams(next, { replace: true });
  };

  return (
    <div>
      <h1 className="text-display font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      {enabled && !selectingModel ? (
        <Button className="mt-4" variant="outline" onClick={() => setOpen(true)}>
          <Trans>Model account</Trans>
        </Button>
      ) : null}
      {open ? (
        <Suspense fallback={null}>
          <AccountModelSettings
            scope="account"
            onClose={() => {
              setOpen(false);
              void checkReady();
            }}
          />
        </Suspense>
      ) : selectingModel ? (
        <Suspense fallback={null}>
          <AccountModelSettings
            embedded
            scope="account"
            onClose={() => undefined}
            onModelsChanged={checkReady}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export function ModelAccountOnboarding(props: Parameters<typeof ModelAccountOnboardingContent>[0]) {
  return (
    <AccountI18n>
      <ModelAccountOnboardingContent {...props} />
    </AccountI18n>
  );
}
