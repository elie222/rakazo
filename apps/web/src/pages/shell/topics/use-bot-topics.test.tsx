// @vitest-environment jsdom
import type { TopicSummary } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

type Topics = { topics: TopicSummary[] };
const threads = vi.hoisted(() => ({
  topics:
    vi.fn<(input: { botId: string }, options?: { signal?: AbortSignal }) => Promise<Topics>>(),
}));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: { threads },
  rpcForSpace: () => ({ threads }),
  createSpaceRpc: () => ({ threads }),
  selectedSpaceId: () => null,
}));

import { spaceQueries } from "../../../lib/query/query";
import { createSpaceRpc } from "../../../lib/query/rpc";
import { spaceChanged } from "../../../lib/query/space-changes";
import { useBotTopics } from "./use-bot-topics";

const topic = (id: string): TopicSummary => ({
  id,
  rootMessageId: `m-${id}`,
  title: id,
  item: false,
  replyCount: 1,
  lastActivityAt: "2026-11-20T10:00:00.000Z",
  unread: false,
  settledBy: null,
});

it("a run change during a topics read leaves that request running and shows the newest answer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const older = deferred<Topics>();
  const newest = deferred<Topics>();
  threads.topics
    .mockResolvedValueOnce({ topics: [] })
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newest.promise);
  let shown: TopicSummary[] = [];
  function Probe() {
    shown = useBotTopics({
      rpc: createSpaceRpc("space-1"),
      queries: spaceQueries("user-1", "space-1"),
      botId: "bot-1",
      openTopic: () => {},
    }).topics;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.waitFor(() => expect(threads.topics).toHaveBeenCalledTimes(1)));

  await act(async () => {
    void spaceChanged("runs", client);
    void spaceChanged("runs", client);
  });
  expect(threads.topics).toHaveBeenCalledTimes(3);
  const aborted = threads.topics.mock.calls.map(([, options]) => options?.signal?.aborted ?? false);
  expect(aborted).toEqual([false, false, false]);

  await act(async () => {
    older.resolve({ topics: [topic("older")] });
    newest.resolve({ topics: [topic("newest")] });
  });
  await act(async () => vi.waitFor(() => expect(shown.map(({ id }) => id)).toEqual(["newest"])));
  await act(async () => root.unmount());
});
