import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "react-router-dom";
import { useSpaceQueries } from "../../lib/query";
import { CallCard, CallReturnBar } from "./CallCard";
import { IncomingCall } from "./IncomingCall";
import { useIncomingCalls } from "./use-incoming-calls";

/**
 * Pages outside the shell keep an ongoing call in reach and still ring for incoming ones;
 * the shell rings from its own roster.
 */
export function CallLayout() {
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const me = useQuery(queries.me.queryOptions()).data;
  const callsEnabled = me?.phoneCallsEnabled === true;
  const calls = useIncomingCalls(callsEnabled ? me.spaceId : undefined);
  const voiceStatus = useQuery({
    ...queries.voice.status.queryOptions(),
    enabled: callsEnabled,
  }).data;
  return (
    <div className="flex h-full flex-col">
      <CallReturnBar />
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <CallCard onSettings={() => navigate("/app?settings=voice")} />
      <IncomingCall
        bots={calls}
        transcribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
        onAnswered={(botId) => navigate(`/app/${botId}`)}
      />
    </div>
  );
}
