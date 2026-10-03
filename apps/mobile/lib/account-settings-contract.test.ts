import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native account unread preference", () => {
  it("keeps the mobile account control connected to durable preferences", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/account.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('t("Mark agent-to-agent messages as unread")');
    expect(source).toContain(
      'rpc<MobileMe>("preferences/update", { markAgentMessagesUnread: next })',
    );
    expect(source).toContain("value={me?.markAgentMessagesUnread ?? false}");
  });
});
