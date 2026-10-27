// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Usage from "../app/(settings)/usage";

const request = vi.hoisted(() => {
  Reflect.set(globalThis, "__DEV__", false);
  return vi.fn();
});
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock("react-native", () => ({
  Platform: { OS: "web", select: (options: { default?: unknown }) => options.default },
  ScrollView: ({ children }: { children: ReactNode }) => children,
  View: ({ children }: { children: ReactNode }) => children,
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../components/connection-quota", () => ({
  ConnectionQuota: ({ label, credentialId }: { label: string; credentialId: string }) => (
    <div>
      {label}: {credentialId}
    </div>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: () => null,
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: () => null,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, detail }: { title: string; detail?: string }) => (
    <div>
      {title} {detail}
    </div>
  ),
}));
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (s: string, values?: Record<string, string>) =>
      values ? s.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "") : s,
    locale: "en",
  }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("./native", () => ({ native: { groupedPage: "white" } }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./settings-target", () => ({ ACCOUNT_SETTINGS: { scope: "account" } }));

afterEach(() => vi.resetAllMocks());

it("shows each connected provider with its own name and the run summary", async () => {
  request.mockImplementation(async (path: string) => {
    if (path === "usage/summary") return { runs: 23, totalTokens: null };
    if (path === "models/list") return [{ provider: "opencode-go", providerName: "OpenCode Go" }];
    if (path === "models/role") return { primary: null, backups: [] };
    if (path === "models/quota")
      return {
        credentialId: "unused",
        status: "unavailable",
        observedAt: null,
        checkedAt: new Date().toISOString(),
        windows: [],
      };
    return [
      { id: "go", provider: "opencode-go", label: "OpenCode Go", hasKey: true },
      { id: "codex", provider: "openai-codex", label: "account@example.test", authKind: "oauth" },
      { id: "empty", provider: "other", label: "Other", hasKey: false },
    ];
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Usage />);
  });
  expect(host.textContent).toContain("23 runs, — tokens");
  expect(host.textContent).toContain("OpenCode Go: go");
  expect(host.textContent).toContain("Codex (account@example.test): codex");
  expect(host.textContent).not.toContain("Other: empty");
  await act(async () => root.unmount());
});
