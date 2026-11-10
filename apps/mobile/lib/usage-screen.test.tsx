// @vitest-environment jsdom

import type { ModelQuota } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Usage from "../app/(settings)/usage";

const request = vi.hoisted(() => {
  Reflect.set(globalThis, "__DEV__", false);
  return vi.fn();
});
const focus = vi.hoisted(() => ({ again: () => {} }));
vi.mock("expo-router", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useFocusEffect: (effect: () => void) => {
      const [visit, setVisit] = useState(0);
      focus.again = () => setVisit((current) => current + 1);
      useEffect(effect, [effect, visit]);
    },
  };
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
const secureStore = vi.hoisted(() => ({ getItemAsync: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../components/connection-quota", () => ({
  ConnectionQuota: ({
    label,
    quota,
    onRefresh,
  }: {
    label: string;
    quota: ModelQuota | null;
    onRefresh: () => void;
  }) => (
    <section>
      <div>[{label}]</div>
      <div>{quota?.status}</div>
      {quota?.windows.map((window) => (
        <div key={window.id}>{100 - window.usedPercent}% remaining</div>
      ))}
      <button type="button" onClick={onRefresh}>
        Refresh
      </button>
    </section>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange("alphabetical")}>
      Sort by name
    </button>
  ),
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
  useUiLocale: () => "en",
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
  expect(host.textContent).toContain("[OpenCode Go]");
  expect(host.textContent).toContain("[Codex (account@example.test)]");
  expect(host.textContent).not.toContain("[Other]");
  await act(async () => root.unmount());
});

it("keeps the last known quota visible when a refresh fails", async () => {
  let quotaCalls = 0;
  request.mockImplementation(async (path: string) => {
    if (path === "models/list") return [];
    if (path === "models/role") return { primary: null, backups: [] };
    if (path === "models/credentials")
      return [{ id: "claude", provider: "anthropic", label: "Claude subscription", hasKey: true }];
    if (path === "models/quota") {
      quotaCalls += 1;
      if (quotaCalls > 1) throw new Error("temporary failure");
      return {
        credentialId: "claude",
        status: "fresh",
        observedAt: "2030-01-01T00:00:00.000Z",
        checkedAt: "2030-01-01T00:00:00.000Z",
        windows: [{ id: "seven_day", usedPercent: 54, resetsAt: null, modelIds: null }],
      };
    }
    return { runs: 0, totalTokens: 0 };
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Usage />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("fresh");
  expect(host.textContent).toContain("46% remaining");
  await act(async () => {
    button(host, "Refresh")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("stale");
  expect(host.textContent).toContain("46% remaining");
  await act(async () => root.unmount());
});

function quotaReading(usedPercent: number): ModelQuota {
  return {
    credentialId: "claude",
    status: "fresh",
    observedAt: "2030-01-01T00:00:00.000Z",
    checkedAt: "2030-01-01T00:00:00.000Z",
    windows: [{ id: "seven_day", usedPercent, resetsAt: null, modelIds: null }],
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function button(host: HTMLElement, name: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === name);
}

it("shows the newest quota read when an older one finishes later", async () => {
  const reads: Array<(quota: ModelQuota) => void> = [];
  request.mockImplementation(async (path: string) => {
    if (path === "models/list") return [];
    if (path === "models/role") return { primary: null, backups: [] };
    if (path === "models/credentials")
      return [{ id: "claude", provider: "anthropic", label: "Claude subscription", hasKey: true }];
    if (path === "models/quota") return new Promise((resolve) => reads.push(resolve));
    return { runs: 0, totalTokens: 0 };
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Usage />);
    await flush();
  });
  await act(async () => {
    button(host, "Refresh")?.click();
    await flush();
  });
  expect(reads).toHaveLength(2);
  await act(async () => {
    reads[1]?.(quotaReading(10));
    await flush();
  });
  await act(async () => {
    reads[0]?.(quotaReading(90));
    await flush();
  });
  expect(host.textContent).toContain("90% remaining");
  expect(host.textContent).not.toContain("10% remaining");
  await act(async () => root.unmount());
});

it("keeps a sort choice made while the saved one is still loading", async () => {
  let finishLoad: (value: string) => void = () => {};
  secureStore.getItemAsync.mockImplementation((key: string) =>
    key === "rakazo.modelUsageSort"
      ? new Promise((resolve) => {
          finishLoad = resolve;
        })
      : Promise.resolve(null),
  );
  request.mockImplementation(async (path: string) => {
    if (path === "models/list") return [];
    if (path === "models/role") return { primary: null, backups: [] };
    if (path === "models/credentials")
      return [
        { id: "beta", provider: "anthropic", label: "Beta", hasKey: true },
        { id: "alpha", provider: "anthropic", label: "Alpha", hasKey: true },
      ];
    if (path === "models/quota") return quotaReading(50);
    return { runs: 0, totalTokens: 0 };
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Usage />);
    await flush();
  });
  await act(async () => {
    button(host, "Sort by name")?.click();
    await flush();
  });
  await act(async () => {
    finishLoad("quota");
    await flush();
  });
  const text = host.textContent ?? "";
  expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"));
  await act(async () => root.unmount());
});

it("does not show the previous visit's connections and totals after a failed reload", async () => {
  let failing = false;
  request.mockImplementation(async (path: string) => {
    if (failing && (path === "models/credentials" || path === "usage/summary"))
      throw new Error("temporary failure");
    if (path === "models/list") return [];
    if (path === "models/role") return { primary: null, backups: [] };
    if (path === "models/credentials")
      return [{ id: "claude", provider: "anthropic", label: "Work", hasKey: true }];
    if (path === "models/quota") return quotaReading(50);
    return { runs: 23, totalTokens: 100 };
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Usage />);
    await flush();
  });
  expect(host.textContent).toContain("Work");
  expect(host.textContent).toContain("23 runs");
  failing = true;
  await act(async () => {
    focus.again();
    await flush();
  });
  expect(host.textContent).toContain("Could not load usage");
  expect(host.textContent).not.toContain("Work");
  expect(host.textContent).not.toContain("23 runs");
  await act(async () => root.unmount());
});
