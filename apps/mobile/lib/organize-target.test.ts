import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSpace } from "./api";
import { rpc } from "./api";
import { findOrganizeTarget } from "./organize-target";

vi.mock("./api", () => ({
  captureApiRequestContext: vi.fn(async () => ({ headers: { authorization: "Bearer fake" } })),
  rpc: vi.fn(),
}));

const chat = { id: "bot-other", spaceId: "space-other" };
const space = {
  id: chat.spaceId,
  bots: [chat],
  groups: [],
  botSections: [],
} as never as MobileSpace;
const current = { bots: [], groups: [], botSections: [] };

beforeEach(() => {
  vi.mocked(rpc).mockReset();
  vi.mocked(rpc).mockResolvedValue({ current: space } as never);
});

describe("cross-space organize", () => {
  it("opens from the other space's cached data without a request", async () => {
    const target = await findOrganizeTarget(
      "bot",
      chat as never,
      { currentSpaceId: "space-current", current, spaces: [space] },
      () => true,
    );
    expect(target).toEqual({
      kind: "bot",
      id: chat.id,
      spaceId: chat.spaceId,
      chat,
      sections: [],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("finds a chat in the current inbox", async () => {
    const own = { id: "bot-own" };
    const sections = [{ id: "s1", name: "Work" }];
    const target = await findOrganizeTarget(
      "bot",
      own as never,
      {
        currentSpaceId: "space-current",
        current: { bots: [own as never], groups: [], botSections: sections as never },
        spaces: [],
      },
      () => true,
    );
    expect(target).toMatchObject({ spaceId: "space-current", chat: own, sections });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fetches missing data in the target space independently of inbox polling", async () => {
    const target = await findOrganizeTarget(
      "bot",
      chat as never,
      { currentSpaceId: "space-current", current, spaces: [] },
      () => true,
    );
    expect(rpc).toHaveBeenCalledWith("spaces/list", undefined, {
      requestContext: {
        headers: { authorization: "Bearer fake", "x-rakazo-space-id": chat.spaceId },
      },
      skipSpaceAuthRecovery: true,
    });
    expect(target).toMatchObject({ chat });
  });

  it("ignores a fallback response after the organize target is closed", async () => {
    let finish!: (value: { current: MobileSpace }) => void;
    vi.mocked(rpc).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as unknown as typeof finish;
        }),
    );
    let fresh = true;
    const pending = findOrganizeTarget(
      "bot",
      chat as never,
      { currentSpaceId: "space-current", current, spaces: [] },
      () => fresh,
    );
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    fresh = false;
    finish({ current: space });
    expect(await pending).toBeNull();
  });

  it("ignores a response for a different space", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({
      current: { ...space, id: "space-third" },
    } as never);
    const target = await findOrganizeTarget(
      "bot",
      chat as never,
      { currentSpaceId: "space-current", current, spaces: [] },
      () => true,
    );
    expect(target).toBeNull();
  });

  it("lets a failed fallback request reach the caller", async () => {
    vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
    await expect(
      findOrganizeTarget(
        "group",
        chat as never,
        { currentSpaceId: "space-current", current, spaces: [] },
        () => true,
      ),
    ).rejects.toThrow("offline");
  });
});
