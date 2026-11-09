// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import NeedsYouScreen from "../app/needs";

// The app has no QueryClientProvider: screens hand the shared client to useQuery
// themselves. Mock that module with a real client so a missing client argument, or a
// useQueryClient() that looks for a provider, fails this render.
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    rpcQuery: () => ({
      queryKey: ["attention/list"],
      queryFn: async () => ({
        items: [
          {
            id: "run-question",
            kind: "question",
            botId: "bot-city",
            botName: "City Scout",
            groupId: null,
            groupName: null,
            threadId: "thread-1",
            runId: "run-1",
            routineId: null,
            messageId: "message-1",
            detail: "Which city should I use?",
            createdAt: "2026-11-09T16:21:02.695Z",
            actions: [{ id: "choice-1", label: "Berlin", answer: "choice-1", tone: "secondary" }],
          },
          {
            id: "run-approval",
            kind: "approval",
            botId: "bot-page",
            botName: "Page Reader",
            groupId: null,
            groupName: null,
            threadId: "thread-2",
            runId: "run-2",
            routineId: null,
            messageId: "message-2",
            detail: "Review before web_fetch",
            createdAt: "2026-11-09T16:21:03.438Z",
            actions: [{ id: "allow", label: "Allow once", answer: "allow", tone: "primary" }],
          },
          {
            id: "run-secret",
            kind: "secret",
            botId: "bot-vault",
            botName: "Vault Bot",
            groupId: null,
            groupName: null,
            threadId: "thread-3",
            runId: "run-3",
            routineId: null,
            messageId: "message-3",
            detail: "API key",
            createdAt: "2026-11-09T16:21:04.438Z",
            actions: [],
          },
        ],
      }),
    }),
  };
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  RefreshControl: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: (styles: object) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ mutedForeground: "#666" }) }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./native", () => ({
  native: { label: "#000", page: "#fff", secondaryLabel: "#666", tertiaryLabel: "#999" },
  useThemedStyles: (factory: () => object) => factory(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    values
      ? text.replace(/\{(\w+)\}/g, (match, key: string) =>
          key in values ? String(values[key]) : match,
        )
      : text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({ errorText: () => "error" }));

describe("NeedsYouScreen", () => {
  it("renders its sections with the shared query client", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(NeedsYouScreen));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Waiting on you");
    expect(container.textContent).toContain("City Scout needs an answer");
    expect(container.textContent).toContain("Page Reader needs approval");
    expect(container.textContent).toContain("Vault Bot needs a sign-in");
    root.unmount();
  });
});
