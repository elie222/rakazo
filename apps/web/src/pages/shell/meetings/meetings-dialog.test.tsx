// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MeetingsDialog from "./meetings-dialog";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: String.raw }),
}));
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    meetings: {
      list: {
        queryOptions: ({ input }: { input: { botId: string } }) => ({
          queryKey: ["offline-meetings", input.botId],
          queryFn: () => list(input),
        }),
      },
    },
  }),
  useSave: () => ({
    pending: false,
    run: () => {
      throw new Error("Unexpected meeting action");
    },
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      size: _size,
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & {
      size?: string;
      variant?: string;
    }) => <button {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
  };
});
vi.mock("./meeting-calendar", () => ({
  MeetingCalendar: () => {
    throw new Error("Unexpected calendar view");
  },
}));
vi.mock("./meeting-transcript", () => ({
  MeetingTranscript: ({ id }: { id: string }) => <output data-testid="transcript-id">{id}</output>,
}));

const firstTime = Date.parse("2026-11-18T12:00:00.000Z");
const secondTime = Date.parse("2026-11-19T18:00:00.000Z");
const meetings = [
  {
    id: "first",
    platform: "zoom",
    status: "ready",
    transcriptAvailable: true,
    createdAt: firstTime,
  },
  {
    id: "second",
    platform: "zoom",
    status: "ready",
    transcriptAvailable: true,
    createdAt: secondTime,
  },
  {
    id: "no-transcript",
    platform: "google_meet",
    status: "ended",
    transcriptAvailable: false,
    createdAt: secondTime,
  },
];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler((callback) => callback());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  list.mockResolvedValue({ enabled: false, meetings });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  i18n.activate("en");
});

it.each(["en", "fr"])("names transcripts using their platform and %s row date", async (locale) => {
  i18n.load(locale, {});
  i18n.activate(locale);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MeetingsDialog botId="offline-bot" showCalendar={false} onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  await act(flush);

  const rows = [...host.querySelectorAll("li")];
  const buttons = rows.map((row) => row.querySelector("button"));
  expect(rows).toHaveLength(3);
  expect(buttons.map((button) => button?.textContent ?? null)).toEqual([
    "View transcript",
    "View transcript",
    null,
  ]);
  const times = [firstTime, secondTime].map((ms) =>
    new Date(ms).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
  expect(rows[0]?.textContent).toContain(times[0]);
  expect(rows[1]?.textContent).toContain(times[1]);
  expect(buttons.map((button) => button?.getAttribute("aria-label") ?? null)).toEqual([
    `View transcript: Zoom, ${times[0]}`,
    `View transcript: Zoom, ${times[1]}`,
    null,
  ]);

  await act(async () => buttons[1]?.click());
  expect(host.querySelector('[data-testid="transcript-id"]')?.textContent).toBe("second");
  expect(list).toHaveBeenCalledExactlyOnceWith({ botId: "offline-bot" });
});
