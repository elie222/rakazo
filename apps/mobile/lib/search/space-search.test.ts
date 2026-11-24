import { SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../api/api";
import { querySpaceSearch } from "./search";

vi.mock("../api/api", () => ({ rpc: vi.fn(async () => ({ hits: [] })) }));

beforeEach(() => {
  vi.mocked(rpc).mockClear();
});

function sentQuery() {
  return vi.mocked(rpc).mock.calls[0]![1] as { q: string };
}

it("sends at most the search query limit and keeps whole characters", async () => {
  // A surrogate pair straddles the limit, so the cut must back off one unit.
  const long = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}\u{1F600}tail`;
  await querySpaceSearch(long);
  const sent = sentQuery().q;
  expect(sent.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
  expect(sent).toBe("a".repeat(SEARCH_QUERY_MAX_LENGTH - 1));
});

it("sends a short query trimmed and unchanged", async () => {
  await querySpaceSearch("  quarterly plan  ");
  expect(sentQuery().q).toBe("quarterly plan");
});
