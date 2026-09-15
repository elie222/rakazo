import type { ThreadMessage } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { quoteDraftForSelection } from "./quote-selection.js";

const message = (id: string) => ({ id, blocks: [{ kind: "text", text: "body" }] }) as ThreadMessage;
const row = (messageId: string) => ({ dataset: { messageId, quotable: "" } });
const unquotableRow = (messageId: string) => ({ dataset: { messageId } });

const messageById = new Map([
  ["message-1", message("message-1")],
  ["progress:run-1", message("progress:run-1")],
]);

describe("quoteDraftForSelection", () => {
  it("resolves a selection inside one message row to that message", () => {
    const r = row("message-1");
    expect(
      quoteDraftForSelection({ startRow: r, endRow: r, text: "  some span  " }, messageById),
    ).toEqual({ message: message("message-1"), text: "some span" });
  });

  it("rejects selections spanning two message rows", () => {
    expect(
      quoteDraftForSelection(
        { startRow: row("message-1"), endRow: row("progress:run-1"), text: "span" },
        messageById,
      ),
    ).toBeNull();
  });

  it("rejects selections outside any message row", () => {
    expect(
      quoteDraftForSelection({ startRow: null, endRow: null, text: "span" }, messageById),
    ).toBeNull();
  });

  it("rejects rows that don't opt into quoting (live progress, subagent cards)", () => {
    const r = unquotableRow("progress:run-1");
    expect(
      quoteDraftForSelection({ startRow: r, endRow: r, text: "span" }, messageById),
    ).toBeNull();
  });

  it("rejects rows whose message is not loaded", () => {
    const r = row("unknown");
    expect(
      quoteDraftForSelection({ startRow: r, endRow: r, text: "span" }, messageById),
    ).toBeNull();
  });

  it("rejects whitespace-only selections", () => {
    const r = row("message-1");
    expect(
      quoteDraftForSelection({ startRow: r, endRow: r, text: "   \n " }, messageById),
    ).toBeNull();
  });

  it("caps the excerpt at the quote limit instead of failing the send", () => {
    const r = row("message-1");
    const draft = quoteDraftForSelection(
      { startRow: r, endRow: r, text: "a".repeat(REPLY_QUOTE_MAX_LENGTH + 500) },
      messageById,
    );
    expect(draft?.text).toHaveLength(REPLY_QUOTE_MAX_LENGTH);
  });
});
