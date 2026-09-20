// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSpace: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("../lib/bootstrap", () => ({
  takeInitialBootstrap: vi.fn().mockResolvedValue({ bots: [] }),
}));
vi.mock("../lib/artifact-open", () => ({
  decodeArtifactBase64: vi.fn(),
  downloadArtifactBytes: vi.fn(),
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: Container,
    AlertDialogAction: Container,
    AlertDialogCancel: Container,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    BotAvatar: () => <span />,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    parseBotAvatar: () => ({ color: undefined }),
    resolvePersonaColorDef: () => ({ hex: "#000000" }),
  };
});

import { ArtifactsPage } from "./Artifacts";

it("opens the Artifacts screen and lists what listSpace returns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockResolvedValue({
    items: [
      {
        id: "artifact-1",
        botId: null,
        groupId: null,
        runId: null,
        name: "Q3 Content Calendar",
        description: null,
        mimeType: "text/markdown",
        size: 128,
        version: 1,
        createdAt: new Date().toISOString(),
        versionCount: 1,
      },
    ],
    nextCursor: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app/artifacts"]}>
          <ArtifactsPage />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain("Artifacts");
    expect(container.textContent).toContain("Q3 Content Calendar");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
