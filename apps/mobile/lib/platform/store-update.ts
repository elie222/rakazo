import { IOS_APP_STORE_URL } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import * as Application from "expo-application";
import { Linking, Platform } from "react-native";
import { queryClient } from "../query/query";

const OFFICIAL_BUNDLE_ID = "com.rakazo.app";
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

type StoreListing = { version: string; url: string | null };

function storeListingKey(bundleId: string | null) {
  return ["store-version", bundleId];
}

function validStoreUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "apps.apple.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      /\/app\/(?:[^/]+\/)?id\d+\/?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function listingUrl(bundleId: string | null, listing?: StoreListing | null): string | null {
  return listing?.url ?? (bundleId === OFFICIAL_BUNDLE_ID ? IOS_APP_STORE_URL : null);
}

/** The listing Apple currently offers for this bundle, or null when it cannot say. */
export async function fetchStoreListing(bundleId: string): Promise<StoreListing | null> {
  const response = await fetch(
    `${STORE_LOOKUP_URL}?bundleId=${encodeURIComponent(bundleId)}&_=${Date.now()}`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    results?: Array<{ version?: unknown; trackViewUrl?: unknown }>;
  };
  const result = body?.results?.[0];
  return typeof result?.version === "string"
    ? { version: result.version, url: validStoreUrl(result.trackViewUrl) }
    : null;
}

/** Whether the App Store has a newer native build with a usable listing. iOS only. */
export function useStoreUpdateAvailable(): boolean {
  const bundleId = Platform.OS === "ios" ? Application.applicationId : null;
  const installed = Application.nativeApplicationVersion;
  const { data } = useQuery(
    {
      queryKey: storeListingKey(bundleId),
      queryFn: () => fetchStoreListing(bundleId ?? ""),
      enabled: Boolean(bundleId && installed),
      staleTime: 60 * 60_000,
    },
    queryClient,
  );
  return Boolean(
    data && installed && listingUrl(bundleId, data) && isNewerVersion(data.version, installed),
  );
}

export function openStoreListing(): void {
  if (Platform.OS !== "ios") return;
  const bundleId = Application.applicationId;
  const listing = queryClient.getQueryData<StoreListing | null>(storeListingKey(bundleId));
  const url = listingUrl(bundleId, listing);
  if (url) void Linking.openURL(url).catch(() => undefined);
}
