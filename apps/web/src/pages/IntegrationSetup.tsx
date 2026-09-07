import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
    void rpc.bots
      .list()
      .then((rows) => {
        if (!rows.length) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setBots(rows);
        setBotId(rows[0]?.id ?? "");
        setReady(true);
      })
      .catch(() => setError(true));
  }, []);
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto max-w-[560px]">
        {bots.length > 1 ? (
          <NativeSelect
            aria-label={t`Bot`}
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            className="mb-6 w-full"
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {ready ? (
          <IntegrationSetup
            botId={botId || undefined}
            onDone={() => navigate(bots.length ? "/app" : "/onboarding")}
          />
        ) : (
          <p>{error ? t`Could not load bots. Reload to try again.` : t`Loading…`}</p>
        )}
      </div>
    </div>
  );
}
