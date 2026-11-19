import * as React from "react";

export type KitLabels = {
  /** The accessible name of a dialog's or sheet's close button. */
  close: string;
  /** The status a spinner announces while it turns. */
  loading: string;
};

const DEFAULTS: KitLabels = { close: "Close", loading: "Loading" };

const KitLabelsContext = React.createContext<KitLabels>(DEFAULTS);

/**
 * The words the kit draws itself, which an app translates for its own locale. A component that
 * shows one of these reads it here; the defaults keep the kit usable on its own.
 */
function KitLabelsProvider({
  children,
  ...labels
}: Partial<KitLabels> & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({
      close: labels.close ?? DEFAULTS.close,
      loading: labels.loading ?? DEFAULTS.loading,
    }),
    [labels.close, labels.loading],
  );
  return <KitLabelsContext.Provider value={value}>{children}</KitLabelsContext.Provider>;
}

function useKitLabels() {
  return React.useContext(KitLabelsContext);
}

export { KitLabelsProvider, useKitLabels };
