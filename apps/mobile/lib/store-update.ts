import { IOS_APP_STORE_URL } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import * as Application from "expo-application";
import { Linking, Platform } from "react-native";
import { queryClient } from "./query";

const STORE_LOOKUP_URL = "https://itunes.apple.com/lookup";

/** True when dotted version `latest` is ahead of `current`; false when either is unreadable. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) =>
    /^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : null;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/** The version the App Store currently offers for this app, or null when it cannot say. */
export async function fetchStoreVersion(bundleId: string): Promise<string | null> {
  const response = await fetch(
    `${STORE_LOOKUP_URL}?bundleId=${encodeURIComponent(bundleId)}&_=${Date.now()}`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { results?: Array<{ version?: unknown }> };
  const version = body.results?.[0]?.version;
  return typeof version === "string" ? version : null;
}

/** Whether the App Store has a newer native build than the one installed. iOS only. */
export function useStoreUpdateAvailable(): boolean {
  const bundleId = Platform.OS === "ios" ? Application.applicationId : null;
  const installed = Application.nativeApplicationVersion;
  const { data } = useQuery(
    {
      queryKey: ["store-version", bundleId],
      queryFn: () => fetchStoreVersion(bundleId ?? ""),
      enabled: Boolean(bundleId && installed),
      staleTime: 60 * 60_000,
    },
    queryClient,
  );
  return Boolean(data && installed && isNewerVersion(data, installed));
}

export function openStoreListing(): void {
  void Linking.openURL(IOS_APP_STORE_URL).catch(() => undefined);
}
