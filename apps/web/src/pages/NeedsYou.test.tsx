// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  attention: { list: vi.fn() },
  bootstrap: vi.fn(),
  answer: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { threads: { answer: api.answer } },
}));
vi.mock("../lib/query", () => ({
  ATTENTION_REFETCH_MS: 30_000,
  useSpaceQueries: () => ({
    attention: {
      list: { queryOptions: () => ({ queryKey: ["attention"], queryFn: api.attention.list }) },
    },
    bootstrap: { queryOptions: () => ({ queryKey: ["bootstrap"], queryFn: api.bootstrap }) },
  }),
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("../lib/desktop", () => ({ desktopBridge: () => null }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => <i data-avatar="bot" />,
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    buttonVariants: (await importOriginal<typeof UiWeb>()).buttonVariants,
    Empty: Container,
    EmptyDescription: Container,
    EmptyHeader: Container,
    EmptyMedia: Container,
    EmptyTitle: Container,
    GroupAvatar: () => <i data-avatar="group" />,
    SectionHeading: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
  };
});

import { NeedsYouPage } from "./NeedsYou";

const baseItem = {
  id: "run:run-1",
  kind: "question" as const,
  botId: "bot-1",
  botName: "Scout",
  groupId: null,
  groupName: null,
  threadId: "thread-1",
  runId: "run-1",
  routineId: null,
  messageId: "message-1",
  detail: "Which city should I use?",
  createdAt: new Date().toISOString(),
  actions: [
    { id: "choice-1", label: "Berlin", answer: "choice-1", tone: "primary" as const },
    { id: "choice-2", label: "Seoul", answer: "choice-2", tone: "secondary" as const },
  ],
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("shows what waits on the user and answers a card in place", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.attention.list.mockResolvedValue({ items: [baseItem] });
  api.bootstrap.mockResolvedValue({ bots: [{ id: "bot-1", name: "Scout" }], groups: [] });
  api.answer.mockResolvedValue({ ok: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <NeedsYouPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Scout needs an answer"));
    expect(container.textContent).toContain("Which city should I use?");

    const seoul = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Seoul",
    );
    expect(seoul).toBeTruthy();
    await act(async () => seoul!.click());
    await settle();

    expect(api.answer).toHaveBeenCalledWith({
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "choice-2",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows the calm empty state when nothing waits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.attention.list.mockResolvedValue({ items: [] });
  api.bootstrap.mockResolvedValue({ bots: [], groups: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <NeedsYouPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Nothing needs you"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps loaded cards when a refresh fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.attention.list
    .mockResolvedValueOnce({ items: [baseItem] })
    .mockRejectedValueOnce(new Error("refresh broke"));
  api.bootstrap.mockResolvedValue({ bots: [{ id: "bot-1", name: "Scout" }], groups: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <NeedsYouPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Scout needs an answer"));

    await act(async () => {
      await client.refetchQueries({ queryKey: ["attention"] });
    });

    await settle();
    expect(container.textContent).toContain("Scout needs an answer");
    expect(container.textContent).toContain("refresh broke");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
