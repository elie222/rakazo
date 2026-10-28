import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { configureMobileMonitoring, reportMobileError, resetMobileMonitoring } from "./monitoring";
import { API_BASE_STORAGE_KEY, DEFAULT_API } from "./server-config";

/** Independent of React: even an initial render failure must reach the collector. */
export function startMobileMonitoring(): void {
  try {
    // Start anonymous reporting before importing the app graph: an import failure must not
    // prevent the configuration request itself. Both paths use the selected server.
    const base = new URL(SecureStore.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API);
    if (base.protocol === "https:" || base.protocol === "http:")
      void configureMobileMonitoring(base.origin, {});
  } catch {
    // Secure storage may be locked during a background launch.
  }
  void attachSessionMonitoring().catch((error: unknown) =>
    reportMobileError(error, "mobile.startup"),
  );
}

async function attachSessionMonitoring(): Promise<void> {
  const { authHeaders, currentApiBase, loadApiBase, subscribeApiBase } = await import("./api");
  const { currentSessionGeneration, subscribeSessionGeneration } = await import("./session");
  let selectedBase: string | undefined;
  const configure = async () => {
    try {
      const generation = currentSessionGeneration();
      const base = currentApiBase();
      const headers = await authHeaders();
      if (base === currentApiBase() && generation === currentSessionGeneration())
        await configureMobileMonitoring(base, headers);
    } catch {
      /* Optional reporting must not become an unhandled startup rejection. */
    }
  };
  const reset = () => {
    resetMobileMonitoring();
    void configure();
  };
  subscribeApiBase(() => {
    const base = currentApiBase();
    if (selectedBase !== undefined && selectedBase !== base) resetMobileMonitoring();
    selectedBase = base;
    void configure();
  });
  subscribeSessionGeneration(reset);
  AppState.addEventListener("change", (state) => {
    if (state === "active") void configure();
  });
  void loadApiBase()
    .then(configure)
    .catch(() => undefined);
}
