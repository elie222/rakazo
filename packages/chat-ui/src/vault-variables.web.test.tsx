// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { rewriteOutsideCode } from "./markdown";
import type { VaultVariables } from "./markdown.web";
import { ChatMarkdown, LinkifiedText, VaultVariablesContext } from "./markdown.web";

vi.mock("./markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown")>();
  return { ...actual, rewriteOutsideCode: vi.fn(actual.rewriteOutsideCode) };
});

function fakeVault(names: string[] | undefined) {
  return {
    want: vi.fn(),
    names: names && new Set(names),
    open: vi.fn(),
    denied: vi.fn(),
    openLabel: (variable: string) => `Open ${variable} in Vault`,
  } satisfies VaultVariables;
}

async function mount(vault: VaultVariables, node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => {
    await act(async () => {
      root.render(
        <VaultVariablesContext.Provider value={vault}>{next}</VaultVariablesContext.Provider>,
      );
    });
  };
  await render(node);
  return {
    container,
    render,
    chips: () => [
      ...container.querySelectorAll<HTMLButtonElement>("button.rk-chat-vault-variable"),
    ],
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(button: HTMLButtonElement | undefined) {
  await act(async () => {
    button?.click();
  });
}

describe("web Vault variables", () => {
  it("opens the viewer's own variable from a bot reply and leaves $HOME and code plain", async () => {
    const vault = fakeVault(["DEPLOY_KEY"]);
    const view = await mount(
      vault,
      <ChatMarkdown>{"Run it with $DEPLOY_KEY, not $HOME or `$DEPLOY_KEY`."}</ChatMarkdown>,
    );
    expect(vault.want).toHaveBeenCalled();
    const [chip, ...rest] = view.chips();
    expect(rest).toEqual([]);
    expect(chip?.textContent).toBe("$DEPLOY_KEY");
    expect(chip?.getAttribute("aria-label")).toBe("Open $DEPLOY_KEY in Vault");
    expect(view.container.textContent).toBe("Run it with $DEPLOY_KEY, not $HOME or $DEPLOY_KEY.");
    await click(chip);
    expect(vault.open).toHaveBeenCalledWith("DEPLOY_KEY");
    await view.cleanup();
  });

  it("says a saved placeholder in another person's message can't be opened, even by name", async () => {
    // Their placeholder names their own Vault, so the viewer's variable of that name isn't it.
    const vault = fakeVault(["PASTED_KEY"]);
    const view = await mount(
      vault,
      <LinkifiedText fromOtherPerson>{"Use [saved as $PASTED_KEY] and $HOME"}</LinkifiedText>,
    );
    const [chip, ...rest] = view.chips();
    expect(rest).toEqual([]);
    expect(chip?.dataset.access).toBe("none");
    expect(view.container.textContent).toBe("Use [saved as $PASTED_KEY] and $HOME");
    await click(chip);
    expect(vault.denied).toHaveBeenCalledTimes(1);
    expect(vault.open).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("opens the viewer's own saved placeholder in a message they sent", async () => {
    const vault = fakeVault(["PASTED_KEY"]);
    const view = await mount(vault, <LinkifiedText>{"Use [saved as $PASTED_KEY]"}</LinkifiedText>);
    const [chip] = view.chips();
    expect(chip?.dataset.access).toBe("own");
    await click(chip);
    expect(vault.open).toHaveBeenCalledWith("PASTED_KEY");
    await view.cleanup();
  });

  it("draws nothing until the viewer's variables are read", async () => {
    const vault = fakeVault(undefined);
    const view = await mount(vault, <LinkifiedText>{"Use [saved as $PASTED_KEY]"}</LinkifiedText>);
    expect(vault.want).toHaveBeenCalled();
    expect(view.chips()).toEqual([]);
    await view.cleanup();
  });

  it("links variables in a streamed reply again only in the block a chunk changes", async () => {
    const vault = fakeVault(["DEPLOY_KEY"]);
    const first = "Use $DEPLOY_KEY here.\n\nThen";
    const view = await mount(vault, <ChatMarkdown streaming>{first}</ChatMarkdown>);
    vi.mocked(rewriteOutsideCode).mockClear();
    await view.render(<ChatMarkdown streaming>{`${first} $DEPLOY_KEY again`}</ChatMarkdown>);
    expect(vi.mocked(rewriteOutsideCode).mock.calls.map(([text]) => text)).toEqual([
      "Then $DEPLOY_KEY again",
    ]);
    expect(view.chips()).toHaveLength(2);
    await view.cleanup();
  });

  it("opens no variable a reply links by hand unless the viewer has it, in the reply's words", async () => {
    const vault = fakeVault(["DEPLOY_KEY"]);
    const view = await mount(
      vault,
      <ChatMarkdown>{"[reveal](rakazo-vault:OTHER) [key](rakazo-vault:DEPLOY_KEY)"}</ChatMarkdown>,
    );
    expect(view.chips().map((chip) => chip.textContent)).toEqual(["key"]);
    expect(view.container.textContent).toBe("reveal key");
    await view.cleanup();
  });
});
