import { modelAccountAuthorizationReason } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient } from "../../lib/auth/auth";
import { modelAccountConfigQuery, modelAccountStatusQuery } from "./queries";

const prompted = new Set<string>();

/** Show required setup once per session and state, preserving the current conversation. */
export function useAccountAuthorizationPrompt(
  userId: string | undefined,
  open: () => void,
  visible = false,
) {
  const sessionId = authClient.useSession().data?.session?.id;
  const config = useQuery({ ...modelAccountConfigQuery, enabled: Boolean(userId) });
  const accountMode = Boolean(userId && config.data?.enabled && config.data.modelAccountOnly);
  const status = useQuery({
    ...modelAccountStatusQuery(userId),
    enabled: accountMode,
    refetchOnWindowFocus: true,
  });
  const state = accountMode ? status.data : undefined;
  const reason = modelAccountAuthorizationReason(state);
  const key = `${userId}:${sessionId}`;
  useEffect(() => {
    if (!state || !userId || !sessionId) return;
    if (!reason) {
      for (const entry of prompted) if (entry.startsWith(`${key}:`)) prompted.delete(entry);
      return;
    }
    const attempt = `${key}:${reason}`;
    if (prompted.has(attempt)) return;
    prompted.add(attempt);
    if (!visible) open();
  }, [key, open, reason, sessionId, state, userId, visible]);
}
