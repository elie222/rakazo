import type { LogoAvatarActivity } from "@rakazo/core";
import { isRunWaitingOnUser, isRunWorking } from "@rakazo/core";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export interface BotAvatarActivitySource {
  subscribe(listener: () => void): () => void;
  getActivity(botId: string, status?: string): LogoAvatarActivity;
}
const emptySource: BotAvatarActivitySource = {
  subscribe: () => () => {},
  getActivity: (_id, status) =>
    status === "failed"
      ? "error"
      : isRunWaitingOnUser(status)
        ? "waiting"
        : isRunWorking(status)
          ? "working"
          : "idle",
};
const Activity = createContext<BotAvatarActivitySource>(emptySource);

/** The app supplies its own event store; shared UI owns no global session state. */
export function BotAvatarActivityProvider({
  source,
  children,
}: {
  source: BotAvatarActivitySource;
  children: ReactNode;
}) {
  return <Activity value={source}>{children}</Activity>;
}
export function useBotAvatarActivity(identity: string, status?: string): LogoAvatarActivity {
  const source = useContext(Activity);
  const get = useCallback(() => source.getActivity(identity, status), [source, identity, status]);
  return useSyncExternalStore(source.subscribe, get, () =>
    emptySource.getActivity(identity, status),
  );
}
