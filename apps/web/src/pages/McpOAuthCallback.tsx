import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";

// The window.open name set by the OAuth popup flow. Providers whose login
// pages send COOP sever window.opener mid-flow, but the window name survives,
// so it is the reliable "we are the popup" marker.
const POPUP_NAME = MCP_OAUTH_CHANNEL;

export function McpOAuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handledState = useRef<string | null>(null);
  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(params.get("error_description") ?? "OAuth authorization was cancelled.");
      return;
    }
    if (handledState.current === state) return;
    handledState.current = state;
    void rpc.mcp.oauth
      .complete({ sessionId: state, code, state })
      .then(() => {
        const channel = new BroadcastChannel(POPUP_NAME);
        channel.postMessage({ type: "mcp-oauth-complete" });
        channel.close();
        if (window.name === POPUP_NAME) {
          setDone(true);
          window.close();
          return;
        }
        navigate("/app?mcp_oauth=connected", { replace: true });
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not complete OAuth"),
      );
  }, [navigate, params]);
  const showReturn = Boolean(error) && window.name !== POPUP_NAME;
  return (
    <div className="grid min-h-screen place-items-center bg-[#050506] p-6 text-center">
      <div>
        <div className="text-lg text-[#F1F1F2]">
          {error ? "OAuth connection failed" : done ? "Connected" : "Finishing MCP connection…"}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-[#85858B]">{error}</p> : null}
        {showReturn ? (
          <button
            type="button"
            onClick={() => navigate("/app")}
            className="mt-5 rounded-xl bg-[#7785FF] px-4 py-2 text-sm font-semibold text-[#090A12]"
          >
            Return to Rakazo
          </button>
        ) : (
          <p className="mt-2 text-sm text-[#85858B]">
            {error || done
              ? "You can close this window."
              : "You can close this tab if it does not redirect automatically."}
          </p>
        )}
      </div>
    </div>
  );
}
