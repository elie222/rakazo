import { modelAccountAuthorizationReason } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentApiBase } from "../lib/api/api";
import {
  currentSessionGeneration,
  loadSessionToken,
  subscribeSessionGeneration,
} from "../lib/api/session";
import { modelAccountConfigQuery, modelAccountStatusQuery } from "../lib/model-account-client";
import { queryClient } from "../lib/query/query";

/** Native navigation keeps the previous screen and its draft in the stack. */
export function AccountAuthorizationPrompt() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const [session, setSession] = useState<{ generation: number; signedIn: boolean }>();
  const signedIn = session?.generation === generation && session.signedIn;
  const pathname = usePathname();
  const router = useRouter();
  const prompted = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadSessionToken().then((token) => {
      if (active) setSession({ generation, signedIn: Boolean(token) });
    });
    return () => {
      active = false;
    };
  }, [generation]);
  const config = useQuery({ ...modelAccountConfigQuery(), enabled: signedIn }, queryClient);
  const accountMode = Boolean(signedIn && config.data?.enabled && config.data.modelAccountOnly);
  const status = useQuery(
    {
      ...modelAccountStatusQuery(),
      enabled: accountMode,
    },
    queryClient,
  );
  const state = accountMode ? status.data : undefined;
  const reason = modelAccountAuthorizationReason(state);
  useEffect(() => {
    if (!signedIn || !state) return;
    if (!reason) {
      prompted.current = null;
      return;
    }
    const key = `${currentApiBase()}:${generation}:${reason}`;
    if (prompted.current === key) return;
    if (pathname === "/model-account") {
      prompted.current = key;
      return;
    }
    if (
      [
        "/sign-in",
        "/signup-survey",
        "/share",
        "/models",
        "/model-connection",
        "/model-picker",
        "/model-authorization",
      ].includes(pathname)
    )
      return;
    prompted.current = key;
    router.push("/(settings)/model-account");
  }, [generation, pathname, reason, router, signedIn, state]);
  return null;
}
