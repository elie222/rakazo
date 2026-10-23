import { AppState } from "react-native";
import { authHeaders, currentApiBase, loadApiBase, subscribeApiBase } from "./api";
import { configureMobileMonitoring, resetMobileMonitoring } from "./monitoring";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

/** Independent of React: even an initial render failure must reach the collector. */
export function startMobileMonitoring(): void {
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
