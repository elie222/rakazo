import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppSelect } from "../components/AppSelect";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { rpc } from "../lib/rpc";

export function IntegrationSetupPage() {
  const navigate = useNavigate();
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setReady(false);
    setError(false);
    let cancelled = false;
    void rpc.bots
      .list()
      .then((rows) => {
        if (cancelled) return;
        if (!rows.length) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setBots(rows);
        setBotId(rows[0]?.id ?? "");
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto max-w-[560px]">
        {bots.length > 1 ? (
          <AppSelect
            aria-label={t`Bot`}
            value={botId}
            className="mb-6 w-full"
            options={bots.map((bot) => ({ value: bot.id, label: bot.name }))}
            onValueChange={setBotId}
          />
        ) : null}
        {ready ? (
          <IntegrationSetup
            botId={botId || undefined}
            onDone={() => navigate(bots.length ? "/app" : "/onboarding")}
          />
        ) : (
          <p>
            {error ? (
              t`Could not load bots. Reload to try again.`
            ) : (
              <Spinner aria-label={t`Loading…`} />
            )}
          </p>
        )}
      </div>
    </div>
  );
}
