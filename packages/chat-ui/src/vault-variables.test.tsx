// @vitest-environment jsdom

import type { BotSecretMetadata } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteOutsideCode } from "./markdown";
import type { VaultRead } from "./vault-variables";
import {
  useVaultVariableMarkdown,
  useVaultVariableReads,
  withVaultVariables,
} from "./vault-variables";

vi.mock("./markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown")>();
  return { ...actual, rewriteOutsideCode: vi.fn(actual.rewriteOutsideCode) };
});

const command = (name: string) => ({ name, auth: { type: "command" } }) as BotSecretMetadata;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rewriteOutsideCode).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("withVaultVariables", () => {
  it("leaves a variable inside raw HTML alone", () => {
    expect(withVaultVariables('<a href="$KEY">open</a>', new Set(["KEY"]))).toBe(
      '<a href="$KEY">open</a>',
    );
  });

  it("parses no text that names none of the viewer's variables", () => {
    expect(withVaultVariables("```sh\necho $HOME\n```", new Set(["KEY"]))).toBe(
      "```sh\necho $HOME\n```",
    );
    expect(rewriteOutsideCode).not.toHaveBeenCalled();
  });
});

describe("useVaultVariableMarkdown", () => {
  it("rewrites only the blocks new text can change while a reply streams", async () => {
    const names = new Set(["KEY"]);
    let markdown = "";
    function Reply({ text }: { text: string }) {
      markdown = useVaultVariableMarkdown(text, names, true);
      return null;
    }
    const first = "Use $KEY here.\n\nThen $KEY there.\n\nAnd";
    const whole = `${first} once more with $KEY`;
    const linked = withVaultVariables(whole, names);
    await act(async () => root.render(createElement(Reply, { text: first })));
    vi.mocked(rewriteOutsideCode).mockClear();
    await act(async () => root.render(createElement(Reply, { text: whole })));
    expect(markdown).toBe(linked);
    expect(vi.mocked(rewriteOutsideCode).mock.calls.map(([text]) => text)).toEqual([
      "And once more with $KEY",
    ]);
  });
});

describe("useVaultVariableReads", () => {
  type Reads = ReturnType<typeof useVaultVariableReads<string>>;
  let reads: Reads | undefined;
  const readAgain = vi.fn<() => Promise<boolean>>();
  const vaults: VaultRead<string>[] = [{ items: [command("other-key")], where: "account" }];

  function Probe({ readsOf }: { readsOf: string }) {
    reads = useVaultVariableReads({ reads: vaults, readsOf, setWanted: () => {}, readAgain });
    return null;
  }

  async function want(readsOf: string, saved: string[]) {
    await act(async () => root.render(createElement(Probe, { readsOf })));
    await act(async () => reads?.want(saved));
    await act(flush);
  }

  beforeEach(() => readAgain.mockReset().mockResolvedValue(true));

  it("checks a saved placeholder again in another Space", async () => {
    await want("space-a", ["PASTED_KEY"]);
    await want("space-a", ["PASTED_KEY"]);
    expect(readAgain).toHaveBeenCalledTimes(1);
    await want("space-b", ["PASTED_KEY"]);
    expect(readAgain).toHaveBeenCalledTimes(2);
  });

  it("tries a read that failed again on the next want", async () => {
    readAgain.mockResolvedValueOnce(false);
    await want("space-a", ["PASTED_KEY"]);
    await want("space-a", ["PASTED_KEY"]);
    await want("space-a", ["PASTED_KEY"]);
    expect(readAgain).toHaveBeenCalledTimes(2);
  });
});
