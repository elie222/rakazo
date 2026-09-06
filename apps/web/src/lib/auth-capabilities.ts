import { useEffect, useState } from "react";

export interface AuthCapabilities {
  provider: "local" | "convex-company-os";
  hosted?: boolean;
  webOrigin?: string;
  companyOsOrigin: string | null;
  passwordReset: boolean;
  resetUrl: string | null;
}
let pending: Promise<AuthCapabilities> | undefined;
export function useAuthCapabilities() {
  const [capabilities, setCapabilities] = useState<AuthCapabilities>();
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function load() {
      pending ??= fetch("/api/auth/capabilities", { signal: AbortSignal.timeout(10000) }).then(
        async (response) => {
          if (!response.ok) throw new Error("Authentication is unavailable");
          return (await response.json()) as AuthCapabilities;
        },
      );
      void pending
        .then((value) => {
          if (active) setCapabilities(value);
        })
        .catch(() => {
          pending = undefined;
          if (active) retry = setTimeout(load, 3000);
        });
    }
    load();
    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, []);
  return capabilities;
}

export function safeLoginReturn(value: string | null) {
  if (!value || !/^\/app(?:\/|\?|$)/.test(value) || /[\\\r\n]/.test(value)) return "/app";
  return value;
}
