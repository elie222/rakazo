import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

export function LocalSettingsPage() {
  const [section, setSection] = useState<"models" | "integrations" | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    void rpc.integrationSetup
      .get()
      .then(() => setReady(true))
      .catch(() => setError(true));
  }, []);
  return (
    <main className="h-full overflow-auto bg-background px-6 py-12">
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-medium">
          <Trans>Local Server Settings</Trans>
        </h1>
        {error ? (
          <p role="alert">
            <Trans>
              Could not open local settings. Start the local server and create its owner account,
              then try again.
            </Trans>
          </p>
        ) : null}
        {ready ? (
          <>
            <nav className="flex gap-2">
              <Button variant="outline" onClick={() => setSection("models")}>
                <Trans>Models</Trans>
              </Button>
              <Button
                variant="outline"
                onClick={() => setSection(section === "integrations" ? null : "integrations")}
              >
                <Trans>Server integrations</Trans>
              </Button>
            </nav>
            {section === "models" ? (
              <ModelSettingsOverlay onClose={() => setSection(null)} localOwner />
            ) : null}
            {section === "integrations" ? <IntegrationSetup serverSetup managedOnly /> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
