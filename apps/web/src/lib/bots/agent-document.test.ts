import { AGENT_IMPORT_MAX_FILE_LENGTH, AgentImportPreviewInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { AGENT_DOCUMENT_MAX_BYTES, readAgentDocument } from "./agent-document";

describe("a chosen agent document", () => {
  it("is refused unread when it is too large", async () => {
    const text = vi.fn(async () => "never");
    expect(await readAgentDocument({ size: AGENT_DOCUMENT_MAX_BYTES + 1, text })).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("is read when it fits", async () => {
    const text = vi.fn(async () => "# Name\nAtlas\n");
    expect(await readAgentDocument({ size: 14, text })).toBe("# Name\nAtlas\n");
  });

  it.each([
    ["ASCII", "a"],
    ["multibyte UTF-8", "界"],
    ["surrogate pairs", "😀"],
  ])("matches the decoded import limit for %s Markdown", async (_encoding, fill) => {
    const path = "agent.md";
    const content = "# Agent\n".padEnd(AGENT_IMPORT_MAX_FILE_LENGTH, fill);
    const overLimit = `${content}a`;
    const oversizedFile = new File([overLimit], path);

    expect(oversizedFile.size).toBeLessThan(AGENT_DOCUMENT_MAX_BYTES);
    expect(AgentImportPreviewInput.safeParse({ files: [{ path, content }] }).success).toBe(true);
    expect(
      AgentImportPreviewInput.safeParse({ files: [{ path, content: overLimit }] }).success,
    ).toBe(false);
    expect(await readAgentDocument(new File([content], path))).toBe(content);
    expect((await readAgentDocument(oversizedFile))?.length ?? null).toBeNull();
  });
});
