import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise MessageRow's actual menu without loading the screen's native dependencies.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const start = source.indexOf("    const messageText = selectableMobileMessageText(message);");
const end = source.indexOf("\n  }, [", start);
const menuSource = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function messageMenu(role: "bot" | "user", blocks: string[]) {
  const text = blocks.map((code) => `\`\`\`\n${code}\n\`\`\``).join("\n\n");
  const setStringAsync = vi.fn(async (_text: string) => undefined);
  // Markdown extraction itself is covered by chat-ui's native parser tests.
  const markdownCodeBlocks = vi.fn(() => blocks);
  const scope = {
    message: { id: "message-1", role, blocks: [{ kind: "text", text }] },
    actions: {},
    readOnly: false,
    onCall: false,
    colorScheme: "light",
    t: (value: string) => value,
    selectableMobileMessageText: () => text,
    blockText: () => text,
    quotableMessageSegments: () => [],
    canReactToThreadMessage: () => false,
    canDoubleTapReact: () => false,
    waitingForUser: false,
    canMarkMessageUnread: () => false,
    markdownCodeBlocks,
    Clipboard: { setStringAsync },
    MESSAGE_REACTIONS: [],
    buildMessageContextMenu: () => [],
    Platform: { OS: "ios" },
  };
  const menu = new Function(...Object.keys(scope), menuSource)(...Object.values(scope)) as {
    actionProps: {
      accessibilityActions: { name: string; label: string }[];
      onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    };
  };
  return { ...menu.actionProps, setStringAsync, markdownCodeBlocks, text };
}

describe("MessageRow code copy accessibility action", () => {
  it("offers Copy code for a bot reply with one block and dispatches its exact text", () => {
    const code = "const a = 1;\n\n  return a;";
    const menu = messageMenu("bot", [code]);
    expect(menu.markdownCodeBlocks).toHaveBeenCalledWith(menu.text);
    expect(menu.accessibilityActions).toContainEqual({ name: "copyCode", label: "Copy code" });
    menu.onAccessibilityAction({ nativeEvent: { actionName: "copyCode" } });
    expect(menu.setStringAsync).toHaveBeenCalledExactlyOnceWith(code);
  });

  it.each([
    ["bot", ["first", "second"]],
    ["bot", []],
    ["user", ["first"]],
  ] as const)("omits Copy code for %s with %j", (role, blocks) => {
    const menu = messageMenu(role, [...blocks]);
    expect(menu.accessibilityActions.some((action) => action.name === "copyCode")).toBe(false);
    menu.onAccessibilityAction({ nativeEvent: { actionName: "copyCode" } });
    expect(menu.setStringAsync).not.toHaveBeenCalled();
    if (role === "user") expect(menu.markdownCodeBlocks).not.toHaveBeenCalled();
  });
});
